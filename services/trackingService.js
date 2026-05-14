// backend/services/trackingService.js
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

class TrackingService {
    constructor(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws/tracking' });
        this.clients = new Map(); // orderId -> Set of clients (WebSocket connections)
        this.sellerSessions = new Map(); // orderId -> seller WebSocket
        this.userSessions = new Map(); // userId -> WebSocket (para enviar notificaciones)
        this.db = null;
        this._initialize();
        this._connectDatabase();
    }

    async _connectDatabase() {
        try {
            if (process.env.DATABASE_URL) {
                this.db = await mysql.createConnection(process.env.DATABASE_URL);
            } else {
                this.db = await mysql.createConnection({
                    host: process.env.MYSQLHOST || 'mysql.railway.internal',
                    port: parseInt(process.env.MYSQLPORT || '3306'),
                    user: process.env.MYSQLUSER || 'root',
                    password: process.env.MYSQLPASSWORD,
                    database: process.env.MYSQLDATABASE || 'railway'
                });
            }
            console.log('✅ [TrackingService] Conectado a MySQL');
        } catch (error) {
            console.error('❌ [TrackingService] Error conectando a MySQL:', error.message);
        }
    }

    _initialize() {
        this.wss.on('connection', (ws, req) => {
            let userId = null;
            let userRole = null;
            let currentOrderId = null;

            // Obtener token de la URL
            const url = new URL(req.url, `http://${req.headers.host}`);
            const token = url.searchParams.get('token');

            if (!token) {
                console.log('❌ [TrackingService] Conexión rechazada: token no proporcionado');
                ws.close(1008, 'Token requerido');
                return;
            }

            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                userId = decoded.userId;
                userRole = decoded.role;
                console.log(`✅ [TrackingService] Cliente conectado: userId=${userId}, role=${userRole}`);
            } catch (error) {
                console.log(`❌ [TrackingService] Token inválido: ${error.message}`);
                ws.close(1008, 'Token inválido');
                return;
            }

            // Registrar usuario
            this.userSessions.set(userId, ws);

            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log(`📨 [TrackingService] Mensaje de ${userId}: ${message.type}`);

                    switch (message.type) {
                        case 'start_tracking':
                            // Vendedor inicia seguimiento
                            currentOrderId = message.orderId;
                            
                            // Verificar que el usuario es el vendedor de este pedido
                            const isSeller = await this._verifySeller(userId, currentOrderId);
                            if (!isSeller && userRole !== 'Administrador') {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: 'No tienes permiso para rastrear este pedido'
                                }));
                                return;
                            }

                            // Guardar sesión del vendedor
                            this.sellerSessions.set(currentOrderId, ws);
                            
                            if (!this.clients.has(currentOrderId)) {
                                this.clients.set(currentOrderId, new Set());
                            }
                            this.clients.get(currentOrderId).add(ws);

                            // Actualizar estado en BD
                            await this._updateTrackingStatus(currentOrderId, 'active', userId);

                            ws.send(JSON.stringify({
                                type: 'tracking_started',
                                orderId: currentOrderId,
                                message: 'Seguimiento iniciado correctamente'
                            }));

                            // Notificar a los compradores que el tracking ha comenzado
                            await this._notifyOrderParticipants(currentOrderId, {
                                type: 'tracking_started',
                                orderId: currentOrderId,
                                message: 'El vendedor ha iniciado el seguimiento de tu pedido'
                            });
                            break;

                        case 'join_tracking':
                            // Comprador se une al seguimiento
                            currentOrderId = message.orderId;
                            
                            if (!this.clients.has(currentOrderId)) {
                                this.clients.set(currentOrderId, new Set());
                            }
                            this.clients.get(currentOrderId).add(ws);

                            // Enviar ubicación actual del vendedor si existe
                            const sellerWs = this.sellerSessions.get(currentOrderId);
                            if (sellerWs && sellerWs.lastLocation) {
                                ws.send(JSON.stringify({
                                    type: 'location_update',
                                    orderId: currentOrderId,
                                    ...sellerWs.lastLocation,
                                    sellerName: sellerWs.sellerName
                                }));
                            }

                            ws.send(JSON.stringify({
                                type: 'tracking_joined',
                                orderId: currentOrderId,
                                message: 'Te has unido al seguimiento del pedido'
                            }));
                            break;

                        case 'update_location':
                            // Vendedor actualiza ubicación
                            if (currentOrderId && this.sellerSessions.get(currentOrderId) === ws) {
                                // Guardar última ubicación en el objeto ws
                                ws.lastLocation = {
                                    lat: message.lat,
                                    lng: message.lng,
                                    address: message.address,
                                    speed: message.speed,
                                    accuracy: message.accuracy,
                                    lastUpdate: new Date().toISOString(),
                                    sellerName: message.sellerName
                                };
                                ws.sellerName = message.sellerName;

                                // Transmitir a todos los clientes del pedido (excepto el vendedor)
                                this._broadcastToOrder(currentOrderId, {
                                    type: 'location_update',
                                    orderId: currentOrderId,
                                    lat: message.lat,
                                    lng: message.lng,
                                    address: message.address,
                                    speed: message.speed,
                                    accuracy: message.accuracy,
                                    sellerName: message.sellerName,
                                    lastUpdate: new Date().toISOString()
                                }, [ws]);

                                // Guardar en BD (opcional, para historial)
                                await this._saveLocationHistory(currentOrderId, message);
                            }
                            break;

                        case 'stop_tracking':
                            // Vendedor detiene seguimiento
                            if (currentOrderId) {
                                this.sellerSessions.delete(currentOrderId);
                                await this._updateTrackingStatus(currentOrderId, 'ended', userId);
                                
                                this._broadcastToOrder(currentOrderId, {
                                    type: 'tracking_ended',
                                    orderId: currentOrderId,
                                    message: 'El vendedor ha finalizado el seguimiento'
                                });
                                
                                ws.send(JSON.stringify({
                                    type: 'tracking_stopped',
                                    message: 'Seguimiento finalizado'
                                }));
                            }
                            break;

                        case 'ping':
                            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
                            break;

                        default:
                            console.log(`⚠️ [TrackingService] Tipo de mensaje desconocido: ${message.type}`);
                    }
                } catch (error) {
                    console.error('❌ [TrackingService] Error procesando mensaje:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Error interno del servidor'
                    }));
                }
            });

            ws.on('close', () => {
                console.log(`🔌 [TrackingService] Cliente desconectado: userId=${userId}, orderId=${currentOrderId}`);
                
                // Limpiar sesiones
                if (currentOrderId) {
                    if (this.sellerSessions.get(currentOrderId) === ws) {
                        this.sellerSessions.delete(currentOrderId);
                        this._broadcastToOrder(currentOrderId, {
                            type: 'seller_disconnected',
                            orderId: currentOrderId,
                            message: 'El vendedor se ha desconectado temporalmente'
                        });
                    }
                    
                    if (this.clients.has(currentOrderId)) {
                        this.clients.get(currentOrderId).delete(ws);
                        if (this.clients.get(currentOrderId).size === 0) {
                            this.clients.delete(currentOrderId);
                        }
                    }
                }
                
                this.userSessions.delete(userId);
            });
        });

        console.log('🚀 [TrackingService] WebSocket server inicializado en /ws/tracking');
    }

    async _verifySeller(userId, orderId) {
        try {
            if (!this.db) return false;
            const [rows] = await this.db.execute(
                `SELECT DISTINCT p.sellerId 
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 WHERE o.id = ? AND p.sellerId = ?`,
                [orderId, userId]
            );
            return rows.length > 0;
        } catch (error) {
            console.error('❌ [TrackingService] Error verificando vendedor:', error);
            return false;
        }
    }

    async _updateTrackingStatus(orderId, status, sellerId) {
        try {
            if (!this.db) return;
            await this.db.execute(
                `INSERT INTO tracking_sessions (orderId, sellerId, status, startedAt, updatedAt)
                 VALUES (?, ?, ?, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE status = ?, updatedAt = NOW()`,
                [orderId, sellerId, status, status]
            );
            console.log(`📝 [TrackingService] Tracking ${status} para orderId=${orderId}`);
        } catch (error) {
            console.error('❌ [TrackingService] Error actualizando tracking:', error);
        }
    }

    async _saveLocationHistory(orderId, location) {
        try {
            if (!this.db) return;
            await this.db.execute(
                `INSERT INTO tracking_locations (orderId, lat, lng, address, speed, accuracy, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [orderId, location.lat, location.lng, location.address || null, location.speed || null, location.accuracy || null]
            );
        } catch (error) {
            console.error('❌ [TrackingService] Error guardando ubicación:', error);
        }
    }

    async _notifyOrderParticipants(orderId, message) {
        try {
            if (!this.db) return;
            
            // Obtener participantes del pedido
            const [participants] = await this.db.execute(
                `SELECT o.userId as buyerId, p.sellerId
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 WHERE o.id = ?
                 LIMIT 1`,
                [orderId]
            );
            
            if (participants.length > 0) {
                // Notificar al comprador
                const buyerWs = this.userSessions.get(participants[0].buyerId);
                if (buyerWs && buyerWs.readyState === WebSocket.OPEN) {
                    buyerWs.send(JSON.stringify(message));
                }
                
                // Notificar al vendedor
                const sellerWs = this.userSessions.get(participants[0].sellerId);
                if (sellerWs && sellerWs !== this.sellerSessions.get(orderId) && sellerWs.readyState === WebSocket.OPEN) {
                    sellerWs.send(JSON.stringify(message));
                }
            }
        } catch (error) {
            console.error('❌ [TrackingService] Error notificando participantes:', error);
        }
    }

    _broadcastToOrder(orderId, message, excludeClients = []) {
        const clients = this.clients.get(orderId);
        if (!clients) return;
        
        const messageStr = JSON.stringify(message);
        clients.forEach(client => {
            if (!excludeClients.includes(client) && client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    }

    // Método público para enviar notificaciones desde otros servicios
    sendNotification(userId, message) {
        const ws = this.userSessions.get(userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    // Método público para obtener estado de tracking
    isTrackingActive(orderId) {
        return this.sellerSessions.has(orderId);
    }

    // Método público para obtener ubicación actual del vendedor
    getSellerLocation(orderId) {
        const sellerWs = this.sellerSessions.get(orderId);
        if (sellerWs && sellerWs.lastLocation) {
            return sellerWs.lastLocation;
        }
        return null;
    }
}

module.exports = TrackingService;