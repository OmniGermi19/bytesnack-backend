const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/reviews - Crear reseña
    router.post('/', authenticateToken, async (req, res) => {
        const { orderId, productId, productName, rating, comment, images } = req.body;

        console.log(`⭐ [Reviews] Nueva reseña: usuario ${req.userId} califica producto ${productId} con ${rating} estrellas`);

        if (!orderId || !productId || !rating) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        if (rating < 0 || rating > 5) {
            return res.status(400).json({ message: 'La calificación debe estar entre 0 y 5' });
        }

        try {
            const [orderCheck] = await db.query(
                `SELECT o.id, o.status, u.nombreCompleto
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN users u ON o.userId = u.id
                 WHERE o.id = ? AND o.userId = ? AND o.status = 'delivered' AND oi.productId = ?`,
                [orderId, req.userId, productId]
            );

            if (orderCheck.length === 0) {
                return res.status(403).json({ message: 'No puedes calificar un producto que no has comprado o que no ha sido entregado' });
            }

            const [existing] = await db.query(
                'SELECT id FROM reviews WHERE orderId = ? AND productId = ? AND userId = ?',
                [orderId, productId, req.userId]
            );

            if (existing.length > 0) {
                return res.status(400).json({ message: 'Ya calificaste este producto' });
            }

            const userName = orderCheck[0].nombreCompleto;
            const imagesJson = images ? JSON.stringify(images) : null;

            const [result] = await db.query(
                `INSERT INTO reviews (orderId, productId, productName, userId, userName, rating, comment, images, isVerifiedPurchase, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW())`,
                [orderId, productId, productName, req.userId, userName, rating, comment || null, imagesJson]
            );

            await _updateProductRating(db, productId);

            const [productInfo] = await db.query(
                'SELECT sellerId, sellerName FROM products WHERE id = ?',
                [productId]
            );

            if (productInfo.length > 0) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'review', FALSE, NOW())`,
                    [productInfo[0].sellerId,
                     '⭐ Nueva calificación',
                     `${userName} calificó "${productName}" con ${rating} estrellas`]
                );
            }

            console.log(`✅ [Reviews] Reseña creada (ID: ${result.insertId})`);
            res.status(201).json({ 
                success: true, 
                id: result.insertId,
                message: 'Calificación guardada exitosamente' 
            });

        } catch (error) {
            console.error('❌ Error creando reseña:', error);
            res.status(500).json({ message: 'Error al guardar la calificación' });
        }
    });

    // GET /api/reviews/product/:productId - Obtener reseñas de un producto
    router.get('/product/:productId', async (req, res) => {
        const { productId } = req.params;
        const { page = 1, limit = 10 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log(`⭐ [Reviews] Obteniendo reseñas del producto ${productId} - página ${page}`);

        try {
            const [reviews] = await db.query(
                `SELECT r.*, 
                    (SELECT COUNT(*) FROM review_likes WHERE reviewId = r.id) as likeCount,
                    (SELECT COUNT(*) FROM review_replies WHERE reviewId = r.id) as replyCount
                 FROM reviews r
                 WHERE r.productId = ?
                 ORDER BY r.createdAt DESC
                 LIMIT ? OFFSET ?`,
                [productId, parseInt(limit), offset]
            );

            for (const review of reviews) {
                const [replies] = await db.query(
                    `SELECT * FROM review_replies WHERE reviewId = ? ORDER BY createdAt ASC`,
                    [review.id]
                );
                review.replies = replies;
                
                if (review.images) {
                    try {
                        review.images = JSON.parse(review.images);
                    } catch (e) {
                        review.images = [];
                    }
                } else {
                    review.images = [];
                }
            }

            const [stats] = await db.query(
                `SELECT 
                    COUNT(*) as totalReviews,
                    AVG(rating) as averageRating,
                    SUM(CASE WHEN rating >= 4.5 THEN 1 ELSE 0 END) as fiveStar,
                    SUM(CASE WHEN rating >= 3.5 AND rating < 4.5 THEN 1 ELSE 0 END) as fourStar,
                    SUM(CASE WHEN rating >= 2.5 AND rating < 3.5 THEN 1 ELSE 0 END) as threeStar,
                    SUM(CASE WHEN rating >= 1.5 AND rating < 2.5 THEN 1 ELSE 0 END) as twoStar,
                    SUM(CASE WHEN rating < 1.5 THEN 1 ELSE 0 END) as oneStar
                 FROM reviews
                 WHERE productId = ?`,
                [productId]
            );

            console.log(`✅ [Reviews] ${reviews.length} reseñas encontradas, promedio: ${stats[0].averageRating || 0}`);
            res.json({
                reviews,
                stats: {
                    totalReviews: stats[0].totalReviews || 0,
                    averageRating: parseFloat(stats[0].averageRating || 0),
                    distribution: {
                        5: stats[0].fiveStar || 0,
                        4: stats[0].fourStar || 0,
                        3: stats[0].threeStar || 0,
                        2: stats[0].twoStar || 0,
                        1: stats[0].oneStar || 0
                    }
                }
            });

        } catch (error) {
            console.error('❌ Error obteniendo reseñas:', error);
            res.status(500).json({ message: 'Error al obtener reseñas' });
        }
    });

    // POST /api/reviews/:reviewId/like - Dar like a una reseña
    router.post('/:reviewId/like', authenticateToken, async (req, res) => {
        const { reviewId } = req.params;

        console.log(`⭐ [Reviews] Usuario ${req.userId} da like a reseña ${reviewId}`);

        try {
            const [existing] = await db.query(
                'SELECT id FROM review_likes WHERE reviewId = ? AND userId = ?',
                [reviewId, req.userId]
            );

            if (existing.length > 0) {
                await db.query(
                    'DELETE FROM review_likes WHERE reviewId = ? AND userId = ?',
                    [reviewId, req.userId]
                );
                await db.query(
                    'UPDATE reviews SET likes = likes - 1 WHERE id = ?',
                    [reviewId]
                );
                console.log(`✅ [Reviews] Like removido de reseña ${reviewId}`);
                res.json({ liked: false, message: 'Like removido' });
            } else {
                await db.query(
                    'INSERT INTO review_likes (reviewId, userId) VALUES (?, ?)',
                    [reviewId, req.userId]
                );
                await db.query(
                    'UPDATE reviews SET likes = likes + 1 WHERE id = ?',
                    [reviewId]
                );
                console.log(`✅ [Reviews] Like agregado a reseña ${reviewId}`);
                res.json({ liked: true, message: 'Like agregado' });
            }

        } catch (error) {
            console.error('❌ Error procesando like:', error);
            res.status(500).json({ message: 'Error al procesar like' });
        }
    });

    // POST /api/reviews/:reviewId/reply - Responder a reseña
    router.post('/:reviewId/reply', authenticateToken, async (req, res) => {
        const { reviewId } = req.params;
        const { comment } = req.body;

        console.log(`⭐ [Reviews] Usuario ${req.userId} responde a reseña ${reviewId}`);

        if (!comment || comment.trim().isEmpty) {
            return res.status(400).json({ message: 'El comentario es requerido' });
        }

        try {
            const [reviewInfo] = await db.query(
                `SELECT r.*, p.sellerId 
                 FROM reviews r
                 JOIN products p ON r.productId = p.id
                 WHERE r.id = ?`,
                [reviewId]
            );

            if (reviewInfo.length === 0) {
                return res.status(404).json({ message: 'Reseña no encontrada' });
            }

            if (reviewInfo[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso para responder' });
            }

            const [userInfo] = await db.query(
                'SELECT nombreCompleto FROM users WHERE id = ?',
                [req.userId]
            );

            await db.query(
                `INSERT INTO review_replies (reviewId, userId, userName, comment, createdAt)
                 VALUES (?, ?, ?, ?, NOW())`,
                [reviewId, req.userId, userInfo[0].nombreCompleto, comment]
            );

            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'review_reply', FALSE, NOW())`,
                [reviewInfo[0].userId,
                 '💬 Respuesta a tu reseña',
                 `El vendedor respondió a tu reseña del producto "${reviewInfo[0].productName}"`]
            );

            console.log(`✅ [Reviews] Respuesta enviada a reseña ${reviewId}`);
            res.json({ success: true, message: 'Respuesta enviada' });

        } catch (error) {
            console.error('❌ Error respondiendo reseña:', error);
            res.status(500).json({ message: 'Error al enviar respuesta' });
        }
    });

    // GET /api/reviews/user - Obtener reseñas del usuario
    router.get('/user', authenticateToken, async (req, res) => {
        console.log(`⭐ [Reviews] Obteniendo reseñas del usuario ${req.userId}`);

        try {
            const [reviews] = await db.query(
                `SELECT r.*, 
                    (SELECT COUNT(*) FROM review_likes WHERE reviewId = r.id) as likeCount
                 FROM reviews r
                 WHERE r.userId = ?
                 ORDER BY r.createdAt DESC`,
                [req.userId]
            );

            for (const review of reviews) {
                if (review.images) {
                    try {
                        review.images = JSON.parse(review.images);
                    } catch (e) {
                        review.images = [];
                    }
                }
            }

            console.log(`✅ [Reviews] ${reviews.length} reseñas encontradas`);
            res.json(reviews);
        } catch (error) {
            console.error('❌ Error obteniendo reseñas:', error);
            res.status(500).json({ message: 'Error al obtener reseñas' });
        }
    });

    // DELETE /api/reviews/:reviewId - Eliminar reseña
    router.delete('/:reviewId', authenticateToken, async (req, res) => {
        const { reviewId } = req.params;

        console.log(`⭐ [Reviews] Eliminando reseña ${reviewId} por usuario ${req.userId}`);

        try {
            const [review] = await db.query(
                'SELECT userId, productId FROM reviews WHERE id = ?',
                [reviewId]
            );

            if (review.length === 0) {
                return res.status(404).json({ message: 'Reseña no encontrada' });
            }

            if (review[0].userId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }

            await db.query('DELETE FROM reviews WHERE id = ?', [reviewId]);
            await _updateProductRating(db, review[0].productId);

            console.log(`✅ [Reviews] Reseña ${reviewId} eliminada`);
            res.json({ success: true, message: 'Reseña eliminada' });

        } catch (error) {
            console.error('❌ Error eliminando reseña:', error);
            res.status(500).json({ message: 'Error al eliminar reseña' });
        }
    });

    return router;
};

async function _updateProductRating(db, productId) {
    const [result] = await db.query(
        'SELECT AVG(rating) as avgRating, COUNT(*) as total FROM reviews WHERE productId = ?',
        [productId]
    );
    
    const avgRating = parseFloat(result[0].avgRating || 0);
    const totalReviews = result[0].total || 0;
    
    await db.query(
        'UPDATE products SET calificacion = ?, totalReviews = ? WHERE id = ?',
        [avgRating, totalReviews, productId]
    );
}