// backend/routes/payments.js
const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');
const Stripe = require('stripe');

// Configurar Stripe con tu clave secreta
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_xxxxxxxxxxxxx');

module.exports = (db) => {
    const router = express.Router();

    // ========== PAGOS CON TARJETA ==========

    // POST /api/payments/create-payment-intent - Crear intención de pago (Tarjeta)
    router.post('/create-payment-intent', authenticateToken, isBuyer, async (req, res) => {
        const { amount, orderId, currency = 'mxn', saveCard = false, paymentMethodId } = req.body;

        console.log(`💳 [Payments] Creando intención de pago: ${amount} ${currency} para pedido ${orderId}`);

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Monto inválido' });
        }

        try {
            // Obtener o crear customer de Stripe para el usuario
            let customerId = await getOrCreateCustomer(db, req.userId, stripe);
            
            const paymentIntentData = {
                amount: Math.round(amount * 100),
                currency: currency.toLowerCase(),
                customer: customerId,
                metadata: {
                    orderId: orderId?.toString() || 'unknown',
                    userId: req.userId.toString()
                },
                automatic_payment_methods: {
                    enabled: true,
                },
            };
            
            // Si se proporciona un paymentMethodId, usarlo
            if (paymentMethodId) {
                paymentIntentData.payment_method = paymentMethodId;
                paymentIntentData.confirm = true;
            }
            
            const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

            // Si se debe guardar la tarjeta y tenemos un paymentMethod
            if (saveCard && paymentIntent.payment_method) {
                await savePaymentMethod(db, req.userId, paymentIntent.payment_method, stripe);
            }

            console.log(`✅ [Payments] PaymentIntent creado: ${paymentIntent.id}`);
            
            res.json({
                success: true,
                clientSecret: paymentIntent.client_secret,
                paymentIntentId: paymentIntent.id,
                paymentMethodId: paymentIntent.payment_method
            });
        } catch (error) {
            console.error('❌ [Payments] Error creando PaymentIntent:', error);
            res.status(500).json({ 
                message: 'Error al procesar el pago con tarjeta',
                error: error.message 
            });
        }
    });

    // POST /api/payments/confirm-payment - Confirmar pago
    router.post('/confirm-payment', authenticateToken, isBuyer, async (req, res) => {
        const { paymentIntentId, orderId, saveCard = false } = req.body;

        console.log(`💳 [Payments] Confirmando pago: ${paymentIntentId} para pedido ${orderId}`);

        try {
            const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

            if (paymentIntent.status === 'succeeded') {
                // Registrar pago en la base de datos
                await db.query(
                    `INSERT INTO payments (orderId, userId, amount, status, paymentMethod, stripePaymentIntentId, createdAt)
                     VALUES (?, ?, ?, 'completed', 'tarjeta', ?, NOW())`,
                    [orderId, req.userId, paymentIntent.amount / 100, paymentIntentId]
                );

                // Guardar tarjeta si se solicitó
                if (saveCard && paymentIntent.payment_method) {
                    await savePaymentMethod(db, req.userId, paymentIntent.payment_method, stripe);
                }

                console.log(`✅ [Payments] Pago confirmado para pedido ${orderId}`);
                
                res.json({
                    success: true,
                    message: 'Pago confirmado correctamente',
                    paymentStatus: 'completed'
                });
            } else {
                res.json({
                    success: false,
                    message: `Pago no completado. Estado: ${paymentIntent.status}`,
                    paymentStatus: paymentIntent.status
                });
            }
        } catch (error) {
            console.error('❌ [Payments] Error confirmando pago:', error);
            res.status(500).json({ 
                message: 'Error al confirmar el pago',
                error: error.message 
            });
        }
    });

    // ========== TARJETAS GUARDADAS ==========

    // GET /api/payments/cards - Obtener tarjetas guardadas del usuario
    router.get('/cards', authenticateToken, async (req, res) => {
        console.log(`💳 [Payments] Obteniendo tarjetas guardadas de usuario ${req.userId}`);

        try {
            const [cards] = await db.query(
                `SELECT id, stripePaymentMethodId, last4, brand, expMonth, expYear, isDefault, createdAt
                 FROM saved_cards
                 WHERE userId = ?
                 ORDER BY isDefault DESC, createdAt DESC`,
                [req.userId]
            );

            res.json({ cards });
        } catch (error) {
            console.error('❌ [Payments] Error obteniendo tarjetas:', error);
            res.status(500).json({ message: 'Error al obtener tarjetas' });
        }
    });

    // POST /api/payments/cards - Agregar nueva tarjeta
    router.post('/cards', authenticateToken, isBuyer, async (req, res) => {
        const { paymentMethodId, setAsDefault = false } = req.body;

        console.log(`💳 [Payments] Agregando tarjeta para usuario ${req.userId}`);

        if (!paymentMethodId) {
            return res.status(400).json({ message: 'ID de método de pago requerido' });
        }

        try {
            const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
            
            if (!paymentMethod.card) {
                return res.status(400).json({ message: 'No es una tarjeta válida' });
            }

            await savePaymentMethod(db, req.userId, paymentMethodId, stripe, setAsDefault);

            res.json({ success: true, message: 'Tarjeta agregada correctamente' });
        } catch (error) {
            console.error('❌ [Payments] Error agregando tarjeta:', error);
            res.status(500).json({ message: 'Error al agregar tarjeta' });
        }
    });

    // DELETE /api/payments/cards/:cardId - Eliminar tarjeta guardada
    router.delete('/cards/:cardId', authenticateToken, async (req, res) => {
        const { cardId } = req.params;

        console.log(`💳 [Payments] Eliminando tarjeta ${cardId} de usuario ${req.userId}`);

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
                        `UPDATE saved_cards SET isDefault = FALSE WHERE id = ?`,
                        [otherCards[0].id]
                    );
                }
            }

            await db.query(`DELETE FROM saved_cards WHERE id = ?`, [cardId]);

            // Opcional: Detach de Stripe (no elimina el método de pago para no afectar suscripciones)
            // await stripe.paymentMethods.detach(card.stripePaymentMethodId);

            res.json({ success: true, message: 'Tarjeta eliminada correctamente' });
        } catch (error) {
            console.error('❌ [Payments] Error eliminando tarjeta:', error);
            res.status(500).json({ message: 'Error al eliminar tarjeta' });
        }
    });

    // PUT /api/payments/cards/:cardId/default - Establecer tarjeta por defecto
    router.put('/cards/:cardId/default', authenticateToken, async (req, res) => {
        const { cardId } = req.params;

        console.log(`💳 [Payments] Estableciendo tarjeta ${cardId} como predeterminada para usuario ${req.userId}`);

        try {
            // Verificar que la tarjeta pertenece al usuario
            const [cards] = await db.query(
                `SELECT id FROM saved_cards WHERE id = ? AND userId = ?`,
                [cardId, req.userId]
            );

            if (cards.length === 0) {
                return res.status(404).json({ message: 'Tarjeta no encontrada' });
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

            res.json({ success: true, message: 'Tarjeta predeterminada actualizada' });
        } catch (error) {
            console.error('❌ [Payments] Error actualizando tarjeta predeterminada:', error);
            res.status(500).json({ message: 'Error al actualizar tarjeta predeterminada' });
        }
    });

    // ========== TRANSFERENCIAS A VENDEDORES ==========

    // POST /api/payments/transfer-to-seller - Transferir pago al vendedor
    router.post('/transfer-to-seller', authenticateToken, isSeller, async (req, res) => {
        const { orderId, amount } = req.body;

        console.log(`💰 [Payments] Iniciando transferencia para pedido ${orderId} a vendedor ${req.userId}`);

        try {
            // Obtener información del vendedor y su cuenta bancaria
            const [sellerInfo] = await db.query(
                `SELECT u.stripeAccountId, u.bankAccountStatus, 
                        sba.stripeBankAccountId, sba.accountHolderName, sba.bankName
                 FROM users u
                 LEFT JOIN seller_bank_accounts sba ON u.id = sba.userId AND sba.isDefault = TRUE
                 WHERE u.id = ?`,
                [req.userId]
            );

            if (sellerInfo.length === 0) {
                return res.status(404).json({ message: 'Vendedor no encontrado' });
            }

            const seller = sellerInfo[0];

            if (seller.bankAccountStatus !== 'verified') {
                return res.status(400).json({ 
                    message: 'Debes tener una cuenta bancaria verificada para recibir pagos',
                    requiresBankAccount: true
                });
            }

            if (!seller.stripeAccountId) {
                return res.status(400).json({ 
                    message: 'No tienes una cuenta de Stripe conectada',
                    requiresStripeConnect: true
                });
            }

            // Crear transferencia a la cuenta conectada del vendedor
            const fee = amount * 0.05; // 5% de comisión
            const netAmount = amount - fee;

            const transfer = await stripe.transfers.create({
                amount: Math.round(netAmount * 100),
                currency: 'mxn',
                destination: seller.stripeAccountId,
                metadata: {
                    orderId: orderId.toString(),
                    sellerId: req.userId.toString()
                }
            });

            // Registrar transferencia en la base de datos
            await db.query(
                `INSERT INTO transfers (orderId, sellerId, buyerId, amount, fee, netAmount, status, stripeTransferId, stripeDestinationId, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, NOW())`,
                [orderId, req.userId, null, amount, fee, netAmount, transfer.id, seller.stripeAccountId]
            );

            // Actualizar estado del pedido
            await db.query(
                `UPDATE orders SET sellerConfirmed = TRUE, updatedAt = NOW() WHERE id = ?`,
                [orderId]
            );

            console.log(`✅ [Payments] Transferencia completada: $${netAmount} para pedido ${orderId}`);
            res.json({ success: true, message: 'Transferencia realizada correctamente' });
        } catch (error) {
            console.error('❌ [Payments] Error en transferencia:', error);
            res.status(500).json({ message: 'Error al procesar la transferencia' });
        }
    });

    return router;
};

// ========== FUNCIONES AUXILIARES ==========

async function getOrCreateCustomer(db, userId, stripe) {
    try {
        // Buscar customer existente
        const [users] = await db.query(
            'SELECT stripeCustomerId FROM users WHERE id = ?',
            [userId]
        );
        
        if (users.length > 0 && users[0].stripeCustomerId) {
            return users[0].stripeCustomerId;
        }
        
        // Crear nuevo customer
        const customer = await stripe.customers.create({
            metadata: { userId: userId.toString() }
        });
        
        // Guardar customer ID en la base de datos
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

async function savePaymentMethod(db, userId, paymentMethodId, stripe, setAsDefault = false) {
    try {
        const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
        
        if (!paymentMethod.card) {
            throw new Error('No es una tarjeta válida');
        }
        
        // Verificar si la tarjeta ya existe
        const [existing] = await db.query(
            'SELECT id FROM saved_cards WHERE stripePaymentMethodId = ? AND userId = ?',
            [paymentMethodId, userId]
        );
        
        if (existing.length > 0) {
            return existing[0].id;
        }
        
        // Si es la primera tarjeta, hacerla default
        const [count] = await db.query(
            'SELECT COUNT(*) as total FROM saved_cards WHERE userId = ?',
            [userId]
        );
        
        const isFirstCard = count[0].total === 0;
        const shouldBeDefault = setAsDefault || isFirstCard;
        
        // Guardar en la base de datos
        const [result] = await db.query(
            `INSERT INTO saved_cards (userId, stripePaymentMethodId, last4, brand, expMonth, expYear, isDefault, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [userId, paymentMethodId, paymentMethod.card.last4, paymentMethod.card.brand, 
             paymentMethod.card.exp_month, paymentMethod.card.exp_year, shouldBeDefault ? 1 : 0]
        );
        
        // Si esta tarjeta es default, quitar default de las demás
        if (shouldBeDefault) {
            await db.query(
                `UPDATE saved_cards SET isDefault = FALSE WHERE userId = ? AND id != ?`,
                [userId, result.insertId]
            );
        }
        
        // Adjuntar método de pago al customer
        const [users] = await db.query('SELECT stripeCustomerId FROM users WHERE id = ?', [userId]);
        if (users.length > 0 && users[0].stripeCustomerId) {
            await stripe.paymentMethods.attach(paymentMethodId, {
                customer: users[0].stripeCustomerId
            });
        }
        
        return result.insertId;
    } catch (error) {
        console.error('❌ Error guardando método de pago:', error);
        throw error;
    }
}