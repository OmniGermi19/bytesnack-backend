// backend/routes/cards.js
const express = require('express');
const { authenticateToken, isBuyer } = require('../middleware/auth');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_xxxxxxxxxxxxx');

module.exports = (db) => {
    const router = express.Router();

    // ========== TARJETAS GUARDADAS ==========

    // GET /api/cards - Obtener todas las tarjetas guardadas del usuario
    router.get('/', authenticateToken, async (req, res) => {
        console.log(`💳 [Cards] Obteniendo tarjetas de usuario ${req.userId}`);

        try {
            const [cards] = await db.query(
                `SELECT id, stripePaymentMethodId, last4, brand, expMonth, expYear, isDefault, createdAt
                 FROM saved_cards
                 WHERE userId = ?
                 ORDER BY isDefault DESC, createdAt DESC`,
                [req.userId]
            );

            console.log(`✅ [Cards] ${cards.length} tarjetas encontradas`);
            res.json({ cards });
        } catch (error) {
            console.error('❌ [Cards] Error obteniendo tarjetas:', error);
            res.status(500).json({ message: 'Error al obtener tarjetas' });
        }
    });

    // POST /api/cards - Agregar nueva tarjeta
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        const { paymentMethodId, setAsDefault = false } = req.body;

        console.log(`💳 [Cards] Agregando tarjeta para usuario ${req.userId}`);

        if (!paymentMethodId) {
            return res.status(400).json({ message: 'ID de método de pago requerido' });
        }

        try {
            // Obtener el método de pago de Stripe
            const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
            
            if (!paymentMethod.card) {
                return res.status(400).json({ message: 'No es una tarjeta válida' });
            }

            // Verificar si la tarjeta ya existe
            const [existing] = await db.query(
                'SELECT id FROM saved_cards WHERE stripePaymentMethodId = ? AND userId = ?',
                [paymentMethodId, req.userId]
            );
            
            if (existing.length > 0) {
                return res.status(400).json({ message: 'Esta tarjeta ya está registrada' });
            }

            // Obtener o crear customer de Stripe
            const customerId = await getOrCreateCustomer(db, req.userId, stripe);
            
            // Adjuntar método de pago al customer
            await stripe.paymentMethods.attach(paymentMethodId, {
                customer: customerId
            });

            // Contar tarjetas existentes
            const [count] = await db.query(
                'SELECT COUNT(*) as total FROM saved_cards WHERE userId = ?',
                [req.userId]
            );
            
            const isFirstCard = count[0].total === 0;
            const shouldBeDefault = setAsDefault || isFirstCard;

            // Guardar en la base de datos
            const [result] = await db.query(
                `INSERT INTO saved_cards (userId, stripePaymentMethodId, last4, brand, expMonth, expYear, isDefault, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [req.userId, paymentMethodId, paymentMethod.card.last4, paymentMethod.card.brand, 
                 paymentMethod.card.exp_month, paymentMethod.card.exp_year, shouldBeDefault ? 1 : 0]
            );
            
            // Si esta tarjeta es default, quitar default de las demás
            if (shouldBeDefault) {
                await db.query(
                    `UPDATE saved_cards SET isDefault = FALSE WHERE userId = ? AND id != ?`,
                    [req.userId, result.insertId]
                );
            }

            console.log(`✅ [Cards] Tarjeta agregada (ID: ${result.insertId})`);
            res.status(201).json({ 
                success: true, 
                message: 'Tarjeta agregada correctamente',
                card: {
                    id: result.insertId,
                    last4: paymentMethod.card.last4,
                    brand: paymentMethod.card.brand,
                    expMonth: paymentMethod.card.exp_month,
                    expYear: paymentMethod.card.exp_year,
                    isDefault: shouldBeDefault
                }
            });
        } catch (error) {
            console.error('❌ [Cards] Error agregando tarjeta:', error);
            res.status(500).json({ message: 'Error al agregar tarjeta: ' + error.message });
        }
    });

    // POST /api/cards/create-payment-method - Crear método de pago desde frontend (setup intent)
    router.post('/create-payment-method', authenticateToken, isBuyer, async (req, res) => {
        console.log(`💳 [Cards] Creando SetupIntent para usuario ${req.userId}`);

        try {
            const customerId = await getOrCreateCustomer(db, req.userId, stripe);
            
            const setupIntent = await stripe.setupIntents.create({
                customer: customerId,
                payment_method_types: ['card'],
            });

            console.log(`✅ [Cards] SetupIntent creado: ${setupIntent.id}`);
            res.json({
                success: true,
                clientSecret: setupIntent.client_secret
            });
        } catch (error) {
            console.error('❌ [Cards] Error creando SetupIntent:', error);
            res.status(500).json({ message: 'Error al crear SetupIntent' });
        }
    });

    // PUT /api/cards/:cardId/default - Establecer tarjeta por defecto
    router.put('/:cardId/default', authenticateToken, async (req, res) => {
        const { cardId } = req.params;

        console.log(`💳 [Cards] Estableciendo tarjeta ${cardId} como predeterminada para usuario ${req.userId}`);

        try {
            // Verificar que la tarjeta pertenece al usuario
            const [card] = await db.query(
                `SELECT id, stripePaymentMethodId FROM saved_cards WHERE id = ? AND userId = ?`,
                [cardId, req.userId]
            );

            if (card.length === 0) {
                return res.status(404).json({ message: 'Tarjeta no encontrada' });
            }

            // Obtener customer ID
            const [user] = await db.query(
                `SELECT stripeCustomerId FROM users WHERE id = ?`,
                [req.userId]
            );

            if (user[0]?.stripeCustomerId) {
                // Actualizar método de pago por defecto en Stripe
                await stripe.customers.update(user[0].stripeCustomerId, {
                    invoice_settings: {
                        default_payment_method: card[0].stripePaymentMethodId
                    }
                });
            }

            // Quitar default de todas las tarjetas
            await db.query(
                `UPDATE saved_cards SET isDefault = FALSE WHERE userId = ?`,
                [req.userId]
            );

            // Establecer la nueva tarjeta como default
            await db.query(
                `UPDATE saved_cards SET isDefault = TRUE WHERE id = ?`,
                [cardId]
            );

            console.log(`✅ [Cards] Tarjeta ${cardId} es ahora la predeterminada`);
            res.json({ success: true, message: 'Tarjeta predeterminada actualizada' });
        } catch (error) {
            console.error('❌ [Cards] Error actualizando tarjeta predeterminada:', error);
            res.status(500).json({ message: 'Error al actualizar tarjeta predeterminada' });
        }
    });

    // DELETE /api/cards/:cardId - Eliminar tarjeta guardada
    router.delete('/:cardId', authenticateToken, async (req, res) => {
        const { cardId } = req.params;

        console.log(`💳 [Cards] Eliminando tarjeta ${cardId} de usuario ${req.userId}`);

        try {
            // Verificar que la tarjeta pertenece al usuario
            const [cards] = await db.query(
                `SELECT id, stripePaymentMethodId, isDefault FROM saved_cards WHERE id = ? AND userId = ?`,
                [cardId, req.userId]
            );

            if (cards.length === 0) {
                return res.status(404).json({ message: 'Tarjeta no encontrada' });
            }

            const card = cards[0];

            // Si es la tarjeta por defecto, asignar otra como default
            if (card.isDefault) {
                const [otherCards] = await db.query(
                    `SELECT id FROM saved_cards WHERE userId = ? AND id != ? LIMIT 1`,
                    [req.userId, cardId]
                );
                
                if (otherCards.length > 0) {
                    await db.query(
                        `UPDATE saved_cards SET isDefault = TRUE WHERE id = ?`,
                        [otherCards[0].id]
                    );
                }
            }

            // Eliminar de la base de datos
            await db.query(`DELETE FROM saved_cards WHERE id = ?`, [cardId]);

            // Opcional: Detach de Stripe (no elimina el método de pago permanentemente)
            try {
                await stripe.paymentMethods.detach(card.stripePaymentMethodId);
            } catch (stripeError) {
                console.log(`⚠️ [Cards] No se pudo detach de Stripe: ${stripeError.message}`);
            }

            console.log(`✅ [Cards] Tarjeta ${cardId} eliminada`);
            res.json({ success: true, message: 'Tarjeta eliminada correctamente' });
        } catch (error) {
            console.error('❌ [Cards] Error eliminando tarjeta:', error);
            res.status(500).json({ message: 'Error al eliminar tarjeta' });
        }
    });

    // POST /api/cards/pay-with-saved-card - Pagar con tarjeta guardada
    router.post('/pay-with-saved-card', authenticateToken, isBuyer, async (req, res) => {
        const { cardId, amount, orderId, currency = 'mxn' } = req.body;

        console.log(`💳 [Cards] Pagando con tarjeta guardada ${cardId} para pedido ${orderId}`);

        if (!cardId || !amount || !orderId) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        try {
            // Obtener la tarjeta guardada
            const [cards] = await db.query(
                `SELECT stripePaymentMethodId FROM saved_cards WHERE id = ? AND userId = ?`,
                [cardId, req.userId]
            );

            if (cards.length === 0) {
                return res.status(404).json({ message: 'Tarjeta no encontrada' });
            }

            const card = cards[0];

            // Obtener customer ID
            const [user] = await db.query(
                `SELECT stripeCustomerId FROM users WHERE id = ?`,
                [req.userId]
            );

            if (!user[0]?.stripeCustomerId) {
                return res.status(400).json({ message: 'Cliente no configurado' });
            }

            // Crear PaymentIntent con la tarjeta guardada
            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency: currency.toLowerCase(),
                customer: user[0].stripeCustomerId,
                payment_method: card.stripePaymentMethodId,
                off_session: true,
                confirm: true,
                metadata: {
                    orderId: orderId.toString(),
                    userId: req.userId.toString(),
                    savedCardId: cardId
                }
            });

            if (paymentIntent.status === 'succeeded') {
                // Registrar pago en la base de datos
                await db.query(
                    `INSERT INTO payments (orderId, userId, amount, status, paymentMethod, stripePaymentIntentId, createdAt)
                     VALUES (?, ?, ?, 'completed', 'tarjeta_guardada', ?, NOW())`,
                    [orderId, req.userId, amount, paymentIntent.id]
                );

                console.log(`✅ [Cards] Pago completado con tarjeta guardada para pedido ${orderId}`);
                
                res.json({
                    success: true,
                    message: 'Pago completado correctamente',
                    paymentIntentId: paymentIntent.id
                });
            } else {
                res.json({
                    success: false,
                    message: `Pago no completado. Estado: ${paymentIntent.status}`,
                    requiresAction: paymentIntent.status === 'requires_action'
                });
            }
        } catch (error) {
            console.error('❌ [Cards] Error procesando pago con tarjeta guardada:', error);
            res.status(500).json({ message: 'Error al procesar el pago: ' + error.message });
        }
    });

    // POST /api/cards/confirm-setup-intent - Confirmar SetupIntent (para guardar tarjeta)
    router.post('/confirm-setup-intent', authenticateToken, isBuyer, async (req, res) => {
        const { setupIntentId, paymentMethodId, setAsDefault = false } = req.body;

        console.log(`💳 [Cards] Confirmando SetupIntent ${setupIntentId} para usuario ${req.userId}`);

        try {
            const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

            if (setupIntent.status === 'succeeded' && paymentMethodId) {
                // Guardar la tarjeta en la base de datos
                const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
                
                if (paymentMethod.card) {
                    // Verificar si ya existe
                    const [existing] = await db.query(
                        'SELECT id FROM saved_cards WHERE stripePaymentMethodId = ? AND userId = ?',
                        [paymentMethodId, req.userId]
                    );
                    
                    if (existing.length === 0) {
                        const [count] = await db.query(
                            'SELECT COUNT(*) as total FROM saved_cards WHERE userId = ?',
                            [req.userId]
                        );
                        
                        const isFirstCard = count[0].total === 0;
                        const shouldBeDefault = setAsDefault || isFirstCard;

                        await db.query(
                            `INSERT INTO saved_cards (userId, stripePaymentMethodId, last4, brand, expMonth, expYear, isDefault, createdAt)
                             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                            [req.userId, paymentMethodId, paymentMethod.card.last4, paymentMethod.card.brand,
                             paymentMethod.card.exp_month, paymentMethod.card.exp_year, shouldBeDefault ? 1 : 0]
                        );
                        
                        if (shouldBeDefault) {
                            await db.query(
                                `UPDATE saved_cards SET isDefault = FALSE WHERE userId = ? AND id != LAST_INSERT_ID()`,
                                [req.userId]
                            );
                        }
                        
                        console.log(`✅ [Cards] Tarjeta guardada exitosamente`);
                    }
                }
            }

            res.json({ success: true, message: 'Tarjeta guardada correctamente' });
        } catch (error) {
            console.error('❌ [Cards] Error confirmando SetupIntent:', error);
            res.status(500).json({ message: 'Error al guardar la tarjeta' });
        }
    });

    return router;
};

// ========== FUNCIÓN AUXILIAR ==========

async function getOrCreateCustomer(db, userId, stripe) {
    try {
        const [users] = await db.query(
            'SELECT stripeCustomerId FROM users WHERE id = ?',
            [userId]
        );
        
        if (users.length > 0 && users[0].stripeCustomerId) {
            return users[0].stripeCustomerId;
        }
        
        const customer = await stripe.customers.create({
            metadata: { userId: userId.toString() }
        });
        
        await db.query(
            'UPDATE users SET stripeCustomerId = ? WHERE id = ?',
            [customer.id, userId]
        );
        
        return customer.id;
    } catch (error) {
        console.error('❌ Error creando/obteniendo customer:', error);
        throw error;
    }
}