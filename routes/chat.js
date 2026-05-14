// backend/routes/chat.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/chat/init - Iniciar o obtener chat
    router.post('/init', authenticateToken, async (req, res) => {
        const { orderId, productId, productName, sellerId, sellerName, buyerName } = req.body;

        console.log(`💬 [Chat] Iniciando chat para pedido ${orderId}, producto ${productId}`);

        if (!orderId || !productId || !sellerId) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        try {
            const isBuyer = req.userId.toString() === buyerId?.toString();
            const isSeller = req.userId.toString() === sellerId.toString();

            if (!isBuyer && !isSeller && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }

            let [chats] = await db.query(
                `SELECT * FROM chats WHERE orderId = ? AND productId = ?`,
                [orderId, productId]
            );

            let chatId;
            if (chats.length === 0) {
                const [result] = await db.query(
                    `INSERT INTO chats (orderId, productId, productName, buyerId, sellerId, status, createdAt)
                     VALUES (?, ?, ?, ?, ?, 'active', NOW())`,
                    [orderId, productId, productName, buyerId || req.userId, sellerId]
                );
                chatId = result.insertId;
                console.log(`✅ [Chat] Chat creado con ID ${chatId}`);
            } else {
                chatId = chats[0].id;
                console.log(`✅ [Chat] Chat existente ID ${chatId}`);
            }

            const [messages] = await db.query(
                `SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC`,
                [chatId]
            );

            const [chatInfo] = await db.query(`SELECT buyerId, sellerId FROM chats WHERE id = ?`, [chatId]);
            if (chatInfo.length > 0) {
                const isBuyerUser = chatInfo[0].buyerId === req.userId;
                if (isBuyerUser) {
                    await db.query(`UPDATE chats SET buyerUnreadCount = 0 WHERE id = ?`, [chatId]);
                    await db.query(
                        `UPDATE messages SET isRead = TRUE, readAt = NOW() 
                         WHERE chatId = ? AND senderId != ? AND isRead = FALSE`,
                        [chatId, req.userId]
                    );
                } else {
                    await db.query(`UPDATE chats SET sellerUnreadCount = 0 WHERE id = ?`, [chatId]);
                    await db.query(
                        `UPDATE messages SET isRead = TRUE, readAt = NOW() 
                         WHERE chatId = ? AND senderId != ? AND isRead = FALSE`,
                        [chatId, req.userId]
                    );
                }
            }

            res.json({
                chatId,
                messages,
                chat: chats[0] || { buyerId, sellerId, productName }
            });

        } catch (error) {
            console.error('❌ Error iniciando chat:', error);
            res.status(500).json({ message: 'Error al iniciar chat' });
        }
    });

    // POST /api/chat/send - Enviar mensaje
    router.post('/send', authenticateToken, async (req, res) => {
        const { chatId, message, type, imageUrl } = req.body;

        console.log(`💬 [Chat] Enviando mensaje al chat ${chatId} de usuario ${req.userId}`);

        if (!chatId || !message) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        try {
            const [chat] = await db.query(
                `SELECT c.*, u.nombreCompleto, u.role 
                 FROM chats c
                 JOIN users u ON u.id = ?
                 WHERE c.id = ? AND (c.buyerId = ? OR c.sellerId = ?)`,
                [req.userId, chatId, req.userId, req.userId]
            );

            if (chat.length === 0 && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }

            const chatData = chat[0];
            const senderRole = chatData.role;
            const senderName = chatData.nombreCompleto;

            const [result] = await db.query(
                `INSERT INTO messages (chatId, senderId, senderName, senderRole, message, type, imageUrl, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [chatId, req.userId, senderName, senderRole, message, type || 'text', imageUrl || null]
            );

            const isBuyer = chatData.buyerId === req.userId;
            if (isBuyer) {
                await db.query(
                    `UPDATE chats SET lastMessage = ?, lastMessageTime = NOW(), sellerUnreadCount = sellerUnreadCount + 1 WHERE id = ?`,
                    [message, chatId]
                );
            } else {
                await db.query(
                    `UPDATE chats SET lastMessage = ?, lastMessageTime = NOW(), buyerUnreadCount = buyerUnreadCount + 1 WHERE id = ?`,
                    [message, chatId]
                );
            }

            console.log(`✅ [Chat] Mensaje enviado (ID: ${result.insertId})`);
            res.status(201).json({
                success: true,
                messageId: result.insertId,
                message: 'Mensaje enviado'
            });

        } catch (error) {
            console.error('❌ Error enviando mensaje:', error);
            res.status(500).json({ message: 'Error al enviar mensaje' });
        }
    });

    // GET /api/chat/conversations - Obtener conversaciones del usuario
    router.get('/conversations', authenticateToken, async (req, res) => {
        try {
            console.log(`💬 [Chat] Obteniendo conversaciones de usuario ${req.userId}`);

            const [conversations] = await db.query(
                `SELECT c.*, 
                    p.name as productName, p.images as productImage,
                    u1.nombreCompleto as buyerName, u1.profileImage as buyerImage,
                    u2.nombreCompleto as sellerName, u2.profileImage as sellerImage
                 FROM chats c
                 LEFT JOIN products p ON c.productId = p.id
                 LEFT JOIN users u1 ON c.buyerId = u1.id
                 LEFT JOIN users u2 ON c.sellerId = u2.id
                 WHERE c.buyerId = ? OR c.sellerId = ?
                 ORDER BY c.lastMessageTime DESC, c.updatedAt DESC`,
                [req.userId, req.userId]
            );

            for (const conv of conversations) {
                if (conv.productImage) {
                    try {
                        const images = JSON.parse(conv.productImage);
                        conv.productImage = images.length > 0 ? images[0] : null;
                    } catch (e) {
                        conv.productImage = null;
                    }
                }
                
                const isBuyer = conv.buyerId === req.userId;
                conv.unreadCount = isBuyer ? conv.buyerUnreadCount : conv.sellerUnreadCount;
                conv.otherUserName = isBuyer ? conv.sellerName : conv.buyerName;
                conv.otherUserImage = isBuyer ? conv.sellerImage : conv.buyerImage;
                conv.otherUserId = isBuyer ? conv.sellerId : conv.buyerId;
            }

            console.log(`✅ [Chat] ${conversations.length} conversaciones encontradas`);
            res.json(conversations);

        } catch (error) {
            console.error('❌ Error obteniendo conversaciones:', error);
            res.status(500).json({ message: 'Error al obtener conversaciones' });
        }
    });

    // GET /api/chat/:chatId/messages - Obtener mensajes de un chat
    router.get('/:chatId/messages', authenticateToken, async (req, res) => {
        const { chatId } = req.params;

        console.log(`💬 [Chat] Obteniendo mensajes del chat ${chatId} para usuario ${req.userId}`);

        try {
            const [chat] = await db.query(
                `SELECT * FROM chats WHERE id = ? AND (buyerId = ? OR sellerId = ?)`,
                [chatId, req.userId, req.userId]
            );

            if (chat.length === 0 && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }

            const [messages] = await db.query(
                `SELECT * FROM messages WHERE chatId = ? ORDER BY createdAt ASC`,
                [chatId]
            );

            const isBuyer = chat[0].buyerId === req.userId;
            if (isBuyer) {
                await db.query(`UPDATE chats SET buyerUnreadCount = 0 WHERE id = ?`, [chatId]);
            } else {
                await db.query(`UPDATE chats SET sellerUnreadCount = 0 WHERE id = ?`, [chatId]);
            }
            
            await db.query(
                `UPDATE messages SET isRead = TRUE, readAt = NOW() 
                 WHERE chatId = ? AND senderId != ? AND isRead = FALSE`,
                [chatId, req.userId]
            );

            console.log(`✅ [Chat] ${messages.length} mensajes obtenidos`);
            res.json(messages);

        } catch (error) {
            console.error('❌ Error obteniendo mensajes:', error);
            res.status(500).json({ message: 'Error al obtener mensajes' });
        }
    });

    // POST /api/chat/:chatId/read - Marcar como leído
    router.post('/:chatId/read', authenticateToken, async (req, res) => {
        const { chatId } = req.params;

        console.log(`💬 [Chat] Marcando chat ${chatId} como leído para usuario ${req.userId}`);

        try {
            const [chat] = await db.query(
                `SELECT buyerId, sellerId FROM chats WHERE id = ?`,
                [chatId]
            );

            if (chat.length === 0) return res.status(404).json({ message: 'Chat no encontrado' });

            const isBuyer = chat[0].buyerId === req.userId;
            if (isBuyer) {
                await db.query(`UPDATE chats SET buyerUnreadCount = 0 WHERE id = ?`, [chatId]);
            } else {
                await db.query(`UPDATE chats SET sellerUnreadCount = 0 WHERE id = ?`, [chatId]);
            }

            await db.query(
                `UPDATE messages SET isRead = TRUE, readAt = NOW() 
                 WHERE chatId = ? AND senderId != ? AND isRead = FALSE`,
                [chatId, req.userId]
            );

            console.log(`✅ [Chat] Marcado como leído`);
            res.json({ success: true });

        } catch (error) {
            console.error('❌ Error marcando como leído:', error);
            res.status(500).json({ message: 'Error al marcar como leído' });
        }
    });

    // GET /api/chat/unread/count - Obtener total de mensajes no leídos
    router.get('/unread/count', authenticateToken, async (req, res) => {
        try {
            const [result] = await db.query(
                `SELECT 
                    COALESCE(SUM(CASE WHEN buyerId = ? THEN buyerUnreadCount ELSE 0 END), 0) as buyerUnread,
                    COALESCE(SUM(CASE WHEN sellerId = ? THEN sellerUnreadCount ELSE 0 END), 0) as sellerUnread
                 FROM chats
                 WHERE buyerId = ? OR sellerId = ?`,
                [req.userId, req.userId, req.userId, req.userId]
            );

            const totalUnread = (result[0]?.buyerUnread || 0) + (result[0]?.sellerUnread || 0);
            console.log(`💬 [Chat] Usuario ${req.userId} tiene ${totalUnread} mensajes no leídos`);
            res.json({ totalUnread });

        } catch (error) {
            console.error('❌ Error obteniendo contador:', error);
            res.status(500).json({ message: 'Error al obtener contador' });
        }
    });

    return router;
};