// backend/routes/payments.js
const express = require('express');
const { authenticateToken, isBuyer } = require('../middleware/auth');
const Stripe = require('stripe');

// Configurar Stripe con tu clave secreta
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_xxxxxxxxxxxxx');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/payments/create-payment-intent - Crear intención de pago (Tarjeta)
    router.post('/create-payment-intent', authenticateToken, isBuyer, async (req, res) => {
        const { amount, orderId, currency = 'mxn' } = req.body;

        console.log(`💳 [Payments] Creando intención de pago: ${amount} ${currency} para pedido ${orderId}`);

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Monto inválido' });
        }

        try {
            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency: currency.toLowerCase(),
                metadata: {
                    orderId: orderId?.toString() || 'unknown',
                    userId: req.userId.toString()
                },
                automatic_payment_methods: {
                    enabled: true,
                },
            });

            console.log(`✅ [Payments] PaymentIntent creado: ${paymentIntent.id}`);
            
            res.json({
                success: true,
                clientSecret: paymentIntent.client_secret,
                paymentIntentId: paymentIntent.id
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
        const { paymentIntentId, orderId } = req.body;

        console.log(`💳 [Payments] Confirmando pago: ${paymentIntentId} para pedido ${orderId}`);

        try {
            const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

            if (paymentIntent.status === 'succeeded') {
                await db.query(
                    `INSERT INTO payments (orderId, userId, amount, status, paymentMethod, stripePaymentIntentId, createdAt)
                     VALUES (?, ?, ?, 'completed', 'tarjeta', ?, NOW())`,
                    [orderId, req.userId, paymentIntent.amount / 100, paymentIntentId]
                );

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

    return router;
};