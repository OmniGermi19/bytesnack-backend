// backend/services/trackingService.js
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

class TrackingService {
    constructor(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws/tracking' });
        this.clients = new Map(); // orderId -> Set of clients
        this.sellerSessions = new Map(); // orderId -> seller WebSocket
        this.userSessions = new Map(); // userId -> WebSocket
        this.locationHistory = new Map(); // orderId -> last 10 locations
        this.heartbeatInterval = null;
        this.db = null;
        this._initialize();
        this._connectDatabase();
        this._startHeartbeat();
        console.log('🚀 [TrackingService] Servicio de tracking inicializado');
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

    _startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            for (const [userId, ws] of this.userSessions) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
                }
            }
        }, 30000);
        console.log('💓 [TrackingService] Heartbeat iniciado (intervalo: 30s)');
    }

    _initialize() {
        this.wss.on('connection', (ws, req) => {
            let userId = null;
            let userRole = null;
            let currentOrderId = null;
            let lastPongReceived = Date.now();

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

            ws.on('pong', () => {
                lastPongReceived = Date.now();
            });

            this.userSessions.set(userId, ws);

            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    
                    switch (message.type) {
                        case 'pong':
                            break;

                        case 'start_tracking':
                            currentOrderId = message.orderId;
                            console.log(`📍 [TrackingService] Iniciando tracking: orderId=${currentOrderId}, userId=${userId}`);
                            
                            const isSeller = await this._verifySeller(userId, currentOrderId);
                            if (!isSeller && userRole !== 'Administrador') {
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: 'No tienes permiso para rastrear este pedido'
                                }));
                                return;
                            }

                            this.sellerSessions.set(currentOrderId, ws);
                            
                            if (!this.clients.has(currentOrderId)) {
                                this.clients.set(currentOrderId, new Set());
                            }
                            this.clients.get(currentOrderId).add(ws);

                            await this._updateTrackingStatus(currentOrderId, 'active', userId);
                            
                            const orderInfo = await this._getOrderInfo(currentOrderId);
                            
                            ws.send(JSON.stringify({
                                type: 'tracking_started',
                                orderId: currentOrderId,
                                message: 'Seguimiento iniciado correctamente',
                                buyerInfo: orderInfo?.buyerInfo
                            }));

                            await this._notifyOrderParticipants(currentOrderId, {
                                type: 'tracking_started',
                                orderId: currentOrderId,
                                message: 'El vendedor ha iniciado el seguimiento de tu pedido'
                            });
                            break;

                        case 'join_tracking':
                            currentOrderId = message.orderId;
                            console.log(`📍 [TrackingService] Uniendo a tracking: orderId=${currentOrderId}, userId=${userId}`);
                            
                            if (!this.clients.has(currentOrderId)) {
                                this.clients.set(currentOrderId, new Set());
                            }
                            this.clients.get(currentOrderId).add(ws);

                            const sellerWs = this.sellerSessions.get(currentOrderId);
                            if (sellerWs && sellerWs.lastLocation) {
                                ws.send(JSON.stringify({
                                    type: 'location_update',
                                    orderId: currentOrderId,
                                    ...sellerWs.lastLocation,
                                    sellerName: sellerWs.sellerName,
                                    isHistorical: false
                                }));
                            }

                            const history = this.locationHistory.get(currentOrderId) || [];
                            if (history.length > 0) {
                                ws.send(JSON.stringify({
                                    type: 'location_history',
                                    orderId: currentOrderId,
                                    locations: history.slice(-5),
                                    sellerName: sellerWs?.sellerName
                                }));
                            }

                            ws.send(JSON.stringify({
                                type: 'tracking_joined',
                                orderId: currentOrderId,
                                message: 'Te has unido al seguimiento del pedido'
                            }));
                            break;

                        case 'update_location':
                            if (currentOrderId && this.sellerSessions.get(currentOrderId) === ws) {
                                if (this._isValidLocation(message.lat, message.lng)) {
                                    const locationData = {
                                        lat: message.lat,
                                        lng: message.lng,
                                        address: message.address || await this._getAddressFromCoords(message.lat, message.lng),
                                        speed: message.speed || 0,
                                        accuracy: message.accuracy || 0,
                                        lastUpdate: new Date().toISOString(),
                                        sellerName: message.sellerName
                                    };
                                    
                                    ws.lastLocation = locationData;
                                    ws.sellerName = message.sellerName;
                                    
                                    if (!this.locationHistory.has(currentOrderId)) {
                                        this.locationHistory.set(currentOrderId, []);
                                    }
                                    const historyList = this.locationHistory.get(currentOrderId);
                                    historyList.push(locationData);
                                    if (historyList.length > 10) historyList.shift();
                                    
                                    this._broadcastToOrder(currentOrderId, {
                                        type: 'location_update',
                                        orderId: currentOrderId,
                                        ...locationData,
                                        isHistorical: false
                                    }, [ws]);
                                    
                                    await this._saveLocationHistory(currentOrderId, locationData);
                                    console.log(`📍 [TrackingService] Ubicación actualizada para orderId=${currentOrderId}`);
                                }
                            }
                            break;

                        case 'stop_tracking':
                            if (currentOrderId) {
                                console.log(`📍 [TrackingService] Deteniendo tracking: orderId=${currentOrderId}, userId=${userId}`);
                                this.sellerSessions.delete(currentOrderId);
                                await this._updateTrackingStatus(currentOrderId, 'ended', userId);
                                this.locationHistory.delete(currentOrderId);
                                
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

                        default:
                            console.log(`⚠️ [TrackingService] Tipo de mensaje desconocido: ${message.type}`);
                    }
                } catch (error) {
                    console.error('❌ Error procesando mensaje:', error);
                }
            });

            ws.on('close', () => {
                console.log(`🔌 [TrackingService] Cliente desconectado: userId=${userId}, orderId=${currentOrderId || 'ninguno'}`);
                
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

    _isValidLocation(lat, lng) {
        return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    }

    async _getAddressFromCoords(lat, lng) {
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
            const data = await response.json();
            return data.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        } catch (error) {
            console.log(`⚠️ [TrackingService] Error obteniendo dirección: ${error.message}`);
            return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        }
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
            console.error('❌ Error verificando vendedor:', error);
            return false;
        }
    }

    async _getOrderInfo(orderId) {
        try {
            if (!this.db) return null;
            const [rows] = await this.db.execute(
                `SELECT o.userId as buyerId, u.nombreCompleto as buyerName, u.numeroControl as buyerControl
                 FROM orders o
                 JOIN users u ON o.userId = u.id
                 WHERE o.id = ?`,
                [orderId]
            );
            return rows[0] || null;
        } catch (error) {
            console.error('❌ Error obteniendo info del pedido:', error);
            return null;
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
            console.error('❌ Error actualizando tracking:', error);
        }
    }

    async _saveLocationHistory(orderId, location) {
        try {
            if (!this.db) return;
            await this.db.execute(
                `INSERT INTO tracking_locations (orderId, lat, lng, address, speed, accuracy, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [orderId, location.lat, location.lng, location.address, location.speed, location.accuracy]
            );
        } catch (error) {
            console.error('❌ Error guardando ubicación:', error);
        }
    }

    async _notifyOrderParticipants(orderId, message) {
        try {
            if (!this.db) return;
            
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
                const buyerWs = this.userSessions.get(participants[0].buyerId);
                if (buyerWs && buyerWs.readyState === WebSocket.OPEN) {
                    buyerWs.send(JSON.stringify(message));
                }
            }
        } catch (error) {
            console.error('❌ Error notificando participantes:', error);
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

    setSellerName(orderId, sellerName) {
        const sellerWs = this.sellerSessions.get(orderId);
        if (sellerWs && sellerWs.readyState === WebSocket.OPEN) {
            sellerWs.send(JSON.stringify({
                type: 'seller_name_updated',
                sellerName: sellerName
            }));
        }
    }

    sendNotification(userId, message) {
        const ws = this.userSessions.get(userId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    isTrackingActive(orderId) {
        return this.sellerSessions.has(orderId);
    }

    getSellerLocation(orderId) {
        const sellerWs = this.sellerSessions.get(orderId);
        if (sellerWs && sellerWs.lastLocation) {
            return sellerWs.lastLocation;
        }
        return null;
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
            console.log('💓 [TrackingService] Heartbeat detenido');
        }
    }
}

module.exports = TrackingService;