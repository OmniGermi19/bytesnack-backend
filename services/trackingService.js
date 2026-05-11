const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

class TrackingService {
    constructor(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws/tracking' });
        this.connections = new Map();
        this.trackingSessions = new Map();
        this.orderLocations = new Map();
        this.init();
    }

    init() {
        this.wss.on('connection', (ws, req) => {
            console.log('🔌 Nuevo cliente WebSocket conectado');
            const token = this.extractToken(req.url);
            let userId = null;
            let userRole = null;

            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                userId = decoded.userId;
                userRole = decoded.role;
                this.connections.set(userId, { ws, role: userRole });
                console.log(`✅ Usuario ${userId} (${userRole}) autenticado`);
                ws.send(JSON.stringify({
                    type: 'connected',
                    message: 'Conectado al servicio de tracking',
                    userId: userId
                }));
            } catch (error) {
                console.log('❌ Autenticación fallida:', error.message);
                ws.close(1008, 'Token inválido');
                return;
            }

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(userId, userRole, message, ws);
                } catch (error) {
                    console.error('Error procesando mensaje:', error);
                }
            });

            ws.on('close', () => {
                console.log(`🔌 Usuario ${userId} desconectado`);
                this.connections.delete(userId);
                this.cleanupUserSessions(userId);
            });
        });
        console.log('🚀 Tracking WebSocket inicializado en /ws/tracking');
    }

    extractToken(url) {
        const tokenParam = url.match(/[?&]token=([^&]+)/);
        return tokenParam ? decodeURIComponent(tokenParam[1]) : null;
    }

    cleanupUserSessions(userId) {
        for (const [orderId, session] of this.trackingSessions) {
            if (session.sellerId === userId) {
                if (session.buyerWs && session.buyerWs.readyState === WebSocket.OPEN) {
                    session.buyerWs.send(JSON.stringify({
                        type: 'seller_disconnected',
                        orderId: orderId,
                        message: 'El vendedor se ha desconectado'
                    }));
                }
                this.trackingSessions.delete(orderId);
                this.orderLocations.delete(orderId);
            } else if (session.buyerId === userId) {
                if (session.sellerWs && session.sellerWs.readyState === WebSocket.OPEN) {
                    session.sellerWs.send(JSON.stringify({
                        type: 'buyer_disconnected',
                        orderId: orderId,
                        message: 'El comprador ha salido'
                    }));
                }
                session.buyerWs = null;
                session.buyerId = null;
                session.status = 'waiting_for_buyer';
            }
        }
    }

    handleMessage(userId, userRole, message, ws) {
        switch (message.type) {
            case 'start_tracking':
                this.startTrackingSession(userId, message.orderId, ws, message.sellerName);
                break;
            case 'join_tracking':
                this.joinTrackingSession(userId, message.orderId, ws);
                break;
            case 'update_location':
                this.updateLocation(userId, message.orderId, message.lat, message.lng, message.address, message.speed, message.accuracy, ws);
                break;
            case 'stop_tracking':
                this.stopTrackingSession(userId, message.orderId);
                break;
            case 'get_status':
                this.getTrackingStatus(userId, message.orderId, ws);
                break;
            default:
                console.log('Mensaje desconocido:', message.type);
        }
    }

    startTrackingSession(sellerId, orderId, ws, sellerName) {
        if (this.trackingSessions.has(orderId)) {
            const existing = this.trackingSessions.get(orderId);
            if (existing.sellerId === sellerId) {
                existing.sellerWs = ws;
                existing.sellerName = sellerName;
                ws.send(JSON.stringify({
                    type: 'tracking_started',
                    orderId: orderId,
                    message: 'Seguimiento iniciado'
                }));
            }
            return;
        }
        this.trackingSessions.set(orderId, {
            sellerId: sellerId,
            buyerId: null,
            sellerWs: ws,
            buyerWs: null,
            status: 'waiting_for_buyer',
            sellerName: sellerName,
            startedAt: new Date().toISOString()
        });
        ws.send(JSON.stringify({
            type: 'tracking_started',
            orderId: orderId,
            message: 'Seguimiento iniciado. Esperando comprador...'
        }));
        console.log(`📡 Tracking iniciado para pedido ${orderId}`);
    }

    joinTrackingSession(buyerId, orderId, ws) {
        const session = this.trackingSessions.get(orderId);
        if (!session) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'El vendedor aún no ha iniciado el seguimiento'
            }));
            return;
        }
        session.buyerId = buyerId;
        session.buyerWs = ws;
        session.status = 'tracking_active';
        if (session.sellerWs && session.sellerWs.readyState === WebSocket.OPEN) {
            session.sellerWs.send(JSON.stringify({
                type: 'buyer_joined',
                orderId: orderId,
                message: 'El comprador se ha unido'
            }));
        }
        const currentLocation = this.orderLocations.get(orderId);
        if (currentLocation) {
            ws.send(JSON.stringify({
                type: 'location_update',
                orderId: orderId,
                lat: currentLocation.lat,
                lng: currentLocation.lng,
                address: currentLocation.address,
                speed: currentLocation.speed,
                accuracy: currentLocation.accuracy,
                lastUpdate: currentLocation.lastUpdate,
                sellerName: currentLocation.sellerName
            }));
        }
        ws.send(JSON.stringify({
            type: 'tracking_joined',
            orderId: orderId,
            message: 'Te has unido al seguimiento'
        }));
        console.log(`👥 Comprador ${buyerId} se unió al pedido ${orderId}`);
    }

    updateLocation(sellerId, orderId, lat, lng, address, speed, accuracy, ws) {
        const session = this.trackingSessions.get(orderId);
        if (!session || session.sellerId !== sellerId) return;
        this.orderLocations.set(orderId, {
            lat: lat,
            lng: lng,
            address: address || 'Ubicación actual',
            speed: speed,
            accuracy: accuracy,
            lastUpdate: new Date().toISOString(),
            sellerName: session.sellerName
        });
        if (session.buyerWs && session.buyerWs.readyState === WebSocket.OPEN) {
            session.buyerWs.send(JSON.stringify({
                type: 'location_update',
                orderId: orderId,
                lat: lat,
                lng: lng,
                address: address,
                speed: speed,
                accuracy: accuracy,
                lastUpdate: new Date().toISOString()
            }));
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'location_sent',
                orderId: orderId,
                timestamp: new Date().toISOString()
            }));
        }
    }

    stopTrackingSession(userId, orderId) {
        const session = this.trackingSessions.get(orderId);
        if (!session) return;
        const isSeller = session.sellerId === userId;
        const isBuyer = session.buyerId === userId;
        if (isSeller) {
            if (session.buyerWs && session.buyerWs.readyState === WebSocket.OPEN) {
                session.buyerWs.send(JSON.stringify({
                    type: 'tracking_ended',
                    orderId: orderId,
                    message: 'El vendedor ha finalizado el seguimiento'
                }));
            }
            this.trackingSessions.delete(orderId);
            this.orderLocations.delete(orderId);
            console.log(`🛑 Vendedor ${userId} finalizó tracking del pedido ${orderId}`);
        } else if (isBuyer) {
            if (session.sellerWs && session.sellerWs.readyState === WebSocket.OPEN) {
                session.sellerWs.send(JSON.stringify({
                    type: 'buyer_left',
                    orderId: orderId,
                    message: 'El comprador salió del seguimiento'
                }));
            }
            session.buyerWs = null;
            session.buyerId = null;
            session.status = 'waiting_for_buyer';
            console.log(`👋 Comprador ${userId} salió del tracking`);
        }
    }

    getTrackingStatus(userId, orderId, ws) {
        const session = this.trackingSessions.get(orderId);
        const location = this.orderLocations.get(orderId);
        if (!session) {
            ws.send(JSON.stringify({
                type: 'status',
                orderId: orderId,
                active: false,
                message: 'No hay seguimiento activo'
            }));
            return;
        }
        const isSeller = session.sellerId === userId;
        const isBuyer = session.buyerId === userId;
        ws.send(JSON.stringify({
            type: 'status',
            orderId: orderId,
            active: true,
            role: isSeller ? 'seller' : (isBuyer ? 'buyer' : 'none'),
            status: session.status,
            location: location || null,
            sellerName: session.sellerName,
            startedAt: session.startedAt
        }));
    }

    setSellerName(orderId, sellerName) {
        const session = this.trackingSessions.get(orderId);
        if (session) {
            session.sellerName = sellerName;
        }
        const location = this.orderLocations.get(orderId);
        if (location) {
            location.sellerName = sellerName;
            this.orderLocations.set(orderId, location);
        }
    }
}

module.exports = TrackingService;