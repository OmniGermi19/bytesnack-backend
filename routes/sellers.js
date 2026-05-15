// backend/routes/sellers.js
const express = require('express');
const { authenticateToken, isSeller } = require('../middleware/auth');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_xxxxxxxxxxxxx');

module.exports = (db) => {
    const router = express.Router();

    // ========== CUENTAS BANCARIAS DE VENDEDORES ==========

    // GET /api/sellers/bank-account - Obtener cuenta bancaria del vendedor
    router.get('/bank-account', authenticateToken, isSeller, async (req, res) => {
        console.log(`🏦 [Sellers] Obteniendo cuenta bancaria de vendedor ${req.userId}`);

        try {
            const [accounts] = await db.query(
                `SELECT id, accountHolderName, bankName, accountNumber, clabe, routingNumber, 
                        isDefault, status, verificationError, createdAt, updatedAt
                 FROM seller_bank_accounts
                 WHERE userId = ?
                 ORDER BY isDefault DESC, createdAt DESC`,
                [req.userId]
            );

            // Obtener estado de cuenta Stripe del usuario
            const [user] = await db.query(
                `SELECT stripeAccountId, bankAccountStatus FROM users WHERE id = ?`,
                [req.userId]
            );

            res.json({ 
                accounts,
                stripeAccountId: user[0]?.stripeAccountId || null,
                bankAccountStatus: user[0]?.bankAccountStatus || 'pending'
            });
        } catch (error) {
            console.error('❌ [Sellers] Error obteniendo cuenta bancaria:', error);
            res.status(500).json({ message: 'Error al obtener cuenta bancaria' });
        }
    });

    // POST /api/sellers/bank-account - Crear cuenta bancaria
    router.post('/bank-account', authenticateToken, isSeller, async (req, res) => {
        const { accountHolderName, bankName, accountNumber, clabe, routingNumber, setAsDefault = true } = req.body;

        console.log(`🏦 [Sellers] Creando cuenta bancaria para vendedor ${req.userId}`);

        if (!accountHolderName || !bankName || !accountNumber) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        try {
            // Verificar si ya existe una cuenta bancaria
            const [existing] = await db.query(
                `SELECT id FROM seller_bank_accounts WHERE userId = ?`,
                [req.userId]
            );

            const isFirstAccount = existing.length === 0;

            // Crear cuenta bancaria en Stripe Connect
            let stripeAccountId = null;
            let stripeBankAccountId = null;

            try {
                // Crear cuenta Connect para el vendedor si no existe
                const [user] = await db.query(
                    `SELECT stripeAccountId FROM users WHERE id = ?`,
                    [req.userId]
                );

                if (!user[0]?.stripeAccountId) {
                    const account = await stripe.accounts.create({
                        type: 'express',
                        country: 'MX',
                        email: req.userEmail || 'seller@example.com',
                        capabilities: {
                            transfers: { requested: true },
                        },
                        business_type: 'individual',
                        metadata: {
                            userId: req.userId.toString()
                        }
                    });
                    stripeAccountId = account.id;

                    await db.query(
                        `UPDATE users SET stripeAccountId = ? WHERE id = ?`,
                        [stripeAccountId, req.userId]
                    );
                } else {
                    stripeAccountId = user[0].stripeAccountId;
                }

                // Crear bank account token y agregar a la cuenta
                const bankAccountToken = await stripe.tokens.create({
                    bank_account: {
                        country: 'MX',
                        currency: 'mxn',
                        account_holder_name: accountHolderName,
                        account_holder_type: 'individual',
                        routing_number: routingNumber || '072000326',
                        account_number: accountNumber
                    }
                });

                const externalAccount = await stripe.accounts.createExternalAccount(
                    stripeAccountId,
                    {
                        external_account: bankAccountToken.id,
                        metadata: {
                            bankName: bankName,
                            userId: req.userId.toString()
                        }
                    }
                );

                stripeBankAccountId = externalAccount.id;
            } catch (stripeError) {
                console.error('⚠️ [Sellers] Error en Stripe:', stripeError.message);
                // Continuar sin Stripe para desarrollo
            }

            // Guardar en la base de datos
            const [result] = await db.query(
                `INSERT INTO seller_bank_accounts 
                 (userId, accountHolderName, bankName, accountNumber, clabe, routingNumber, 
                  stripeBankAccountId, isDefault, status, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
                [req.userId, accountHolderName, bankName, accountNumber, clabe || null, 
                 routingNumber || null, stripeBankAccountId, setAsDefault ? 1 : 0]
            );

            // Si es la primera cuenta o es la predeterminada, actualizar estado del usuario
            if (setAsDefault || isFirstAccount) {
                await db.query(
                    `UPDATE seller_bank_accounts SET isDefault = FALSE WHERE userId = ? AND id != ?`,
                    [req.userId, result.insertId]
                );
                
                await db.query(
                    `UPDATE users SET bankAccountStatus = 'pending' WHERE id = ?`,
                    [req.userId]
                );
            }

            console.log(`✅ [Sellers] Cuenta bancaria creada (ID: ${result.insertId})`);
            res.status(201).json({ 
                success: true, 
                message: 'Cuenta bancaria registrada. Pendiente de verificación.',
                accountId: result.insertId
            });
        } catch (error) {
            console.error('❌ [Sellers] Error creando cuenta bancaria:', error);
            res.status(500).json({ message: 'Error al crear cuenta bancaria: ' + error.message });
        }
    });

    // PUT /api/sellers/bank-account/:accountId - Actualizar cuenta bancaria
    router.put('/bank-account/:accountId', authenticateToken, isSeller, async (req, res) => {
        const { accountId } = req.params;
        const { accountHolderName, bankName, accountNumber, clabe, routingNumber } = req.body;

        console.log(`🏦 [Sellers] Actualizando cuenta bancaria ${accountId}`);

        try {
            // Verificar que la cuenta pertenece al usuario
            const [existing] = await db.query(
                `SELECT id FROM seller_bank_accounts WHERE id = ? AND userId = ?`,
                [accountId, req.userId]
            );

            if (existing.length === 0) {
                return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });
            }

            const updates = [];
            const params = [];

            if (accountHolderName) {
                updates.push('accountHolderName = ?');
                params.push(accountHolderName);
            }
            if (bankName) {
                updates.push('bankName = ?');
                params.push(bankName);
            }
            if (accountNumber) {
                updates.push('accountNumber = ?');
                params.push(accountNumber);
            }
            if (clabe) {
                updates.push('clabe = ?');
                params.push(clabe);
            }
            if (routingNumber) {
                updates.push('routingNumber = ?');
                params.push(routingNumber);
            }

            updates.push('updatedAt = NOW()');
            params.push(accountId);

            if (updates.length > 1) {
                await db.query(
                    `UPDATE seller_bank_accounts SET ${updates.join(', ')} WHERE id = ?`,
                    params
                );
                
                // Cambiar estado a pendiente para revisión
                await db.query(
                    `UPDATE seller_bank_accounts SET status = 'pending' WHERE id = ?`,
                    [accountId]
                );
                
                await db.query(
                    `UPDATE users SET bankAccountStatus = 'pending' WHERE id = ?`,
                    [req.userId]
                );
            }

            console.log(`✅ [Sellers] Cuenta bancaria ${accountId} actualizada`);
            res.json({ success: true, message: 'Cuenta bancaria actualizada' });
        } catch (error) {
            console.error('❌ [Sellers] Error actualizando cuenta bancaria:', error);
            res.status(500).json({ message: 'Error al actualizar cuenta bancaria' });
        }
    });

    // DELETE /api/sellers/bank-account/:accountId - Eliminar cuenta bancaria
    router.delete('/bank-account/:accountId', authenticateToken, isSeller, async (req, res) => {
        const { accountId } = req.params;

        console.log(`🏦 [Sellers] Eliminando cuenta bancaria ${accountId}`);

        try {
            // Verificar que la cuenta pertenece al usuario
            const [account] = await db.query(
                `SELECT id, isDefault FROM seller_bank_accounts WHERE id = ? AND userId = ?`,
                [accountId, req.userId]
            );

            if (account.length === 0) {
                return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });
            }

            // Si es la cuenta predeterminada, asignar otra como default
            if (account[0].isDefault) {
                const [otherAccounts] = await db.query(
                    `SELECT id FROM seller_bank_accounts WHERE userId = ? AND id != ? LIMIT 1`,
                    [req.userId, accountId]
                );
                
                if (otherAccounts.length > 0) {
                    await db.query(
                        `UPDATE seller_bank_accounts SET isDefault = TRUE WHERE id = ?`,
                        [otherAccounts[0].id]
                    );
                }
            }

            await db.query(
                `DELETE FROM seller_bank_accounts WHERE id = ?`,
                [accountId]
            );

            // Si no quedan cuentas, actualizar estado del usuario
            const [remaining] = await db.query(
                `SELECT COUNT(*) as total FROM seller_bank_accounts WHERE userId = ?`,
                [req.userId]
            );

            if (remaining[0].total === 0) {
                await db.query(
                    `UPDATE users SET bankAccountStatus = 'pending' WHERE id = ?`,
                    [req.userId]
                );
            }

            console.log(`✅ [Sellers] Cuenta bancaria ${accountId} eliminada`);
            res.json({ success: true, message: 'Cuenta bancaria eliminada' });
        } catch (error) {
            console.error('❌ [Sellers] Error eliminando cuenta bancaria:', error);
            res.status(500).json({ message: 'Error al eliminar cuenta bancaria' });
        }
    });

    // PUT /api/sellers/bank-account/:accountId/default - Establecer cuenta predeterminada
    router.put('/bank-account/:accountId/default', authenticateToken, isSeller, async (req, res) => {
        const { accountId } = req.params;

        console.log(`🏦 [Sellers] Estableciendo cuenta bancaria ${accountId} como predeterminada`);

        try {
            // Verificar que la cuenta pertenece al usuario
            const [account] = await db.query(
                `SELECT id FROM seller_bank_accounts WHERE id = ? AND userId = ?`,
                [accountId, req.userId]
            );

            if (account.length === 0) {
                return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });
            }

            // Quitar predeterminada de todas las cuentas
            await db.query(
                `UPDATE seller_bank_accounts SET isDefault = FALSE WHERE userId = ?`,
                [req.userId]
            );

            // Establecer la nueva cuenta como predeterminada
            await db.query(
                `UPDATE seller_bank_accounts SET isDefault = TRUE WHERE id = ?`,
                [accountId]
            );

            console.log(`✅ [Sellers] Cuenta bancaria ${accountId} es ahora la predeterminada`);
            res.json({ success: true, message: 'Cuenta bancaria predeterminada actualizada' });
        } catch (error) {
            console.error('❌ [Sellers] Error actualizando cuenta predeterminada:', error);
            res.status(500).json({ message: 'Error al actualizar cuenta predeterminada' });
        }
    });

    // POST /api/sellers/verify-bank-account - Solicitar verificación (Admin)
    router.post('/verify-bank-account/:userId', authenticateToken, async (req, res) => {
        const { userId } = req.params;
        const { verified, rejectionReason } = req.body;

        if (req.userRole !== 'Administrador') {
            return res.status(403).json({ message: 'No tienes permiso' });
        }

        console.log(`🏦 [Sellers] ${verified ? 'Verificando' : 'Rechazando'} cuenta bancaria de usuario ${userId}`);

        try {
            const status = verified ? 'verified' : 'rejected';
            
            await db.query(
                `UPDATE seller_bank_accounts SET status = ?, verificationError = ? WHERE userId = ? AND isDefault = TRUE`,
                [status, rejectionReason || null, userId]
            );
            
            await db.query(
                `UPDATE users SET bankAccountStatus = ? WHERE id = ?`,
                [status, userId]
            );

            // Notificar al vendedor
            const title = verified ? '✅ Cuenta bancaria verificada' : '❌ Cuenta bancaria rechazada';
            const message = verified 
                ? 'Tu cuenta bancaria ha sido verificada. Ahora puedes recibir pagos por tus ventas.'
                : `Tu cuenta bancaria ha sido rechazada. Motivo: ${rejectionReason || 'No especificado'}. Por favor corrige los datos y vuelve a enviarla.`;

            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'bank_account', FALSE, NOW())`,
                [userId, title, message]
            );

            console.log(`✅ [Sellers] Cuenta bancaria de usuario ${userId} ${verified ? 'verificada' : 'rechazada'}`);
            res.json({ success: true, message: `Cuenta bancaria ${verified ? 'verificada' : 'rechazada'} correctamente` });
        } catch (error) {
            console.error('❌ [Sellers] Error verificando cuenta bancaria:', error);
            res.status(500).json({ message: 'Error al verificar cuenta bancaria' });
        }
    });

    // GET /api/sellers/pending-verifications - Obtener cuentas pendientes (Admin)
    router.get('/pending-verifications', authenticateToken, async (req, res) => {
        if (req.userRole !== 'Administrador') {
            return res.status(403).json({ message: 'No tienes permiso' });
        }

        console.log(`🏦 [Sellers] Obteniendo cuentas bancarias pendientes de verificación`);

        try {
            const [accounts] = await db.query(
                `SELECT sba.*, u.nombreCompleto, u.email, u.numeroControl
                 FROM seller_bank_accounts sba
                 JOIN users u ON sba.userId = u.id
                 WHERE sba.status = 'pending'
                 ORDER BY sba.createdAt ASC`,
                []
            );

            console.log(`✅ [Sellers] ${accounts.length} cuentas pendientes encontradas`);
            res.json({ accounts });
        } catch (error) {
            console.error('❌ [Sellers] Error obteniendo cuentas pendientes:', error);
            res.status(500).json({ message: 'Error al obtener cuentas pendientes' });
        }
    });

    // POST /api/sellers/create-stripe-connect - Crear cuenta Stripe Connect (para onboarding)
    router.post('/create-stripe-connect', authenticateToken, isSeller, async (req, res) => {
        console.log(`🏦 [Sellers] Creando cuenta Stripe Connect para vendedor ${req.userId}`);

        try {
            const [user] = await db.query(
                `SELECT email, nombreCompleto FROM users WHERE id = ?`,
                [req.userId]
            );

            if (user.length === 0) {
                return res.status(404).json({ message: 'Usuario no encontrado' });
            }

            // Verificar si ya tiene cuenta
            if (user[0].stripeAccountId) {
                // Generar link de onboarding para cuenta existente
                const accountLink = await stripe.accountLinks.create({
                    account: user[0].stripeAccountId,
                    refresh_url: `${process.env.FRONTEND_URL}/seller/bank-account`,
                    return_url: `${process.env.FRONTEND_URL}/seller/bank-account/success`,
                    type: 'account_onboarding',
                });
                
                return res.json({ 
                    success: true, 
                    url: accountLink.url,
                    hasAccount: true
                });
            }

            // Crear nueva cuenta Connect
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'MX',
                email: user[0].email,
                business_type: 'individual',
                individual: {
                    first_name: user[0].nombreCompleto.split(' ')[0],
                    last_name: user[0].nombreCompleto.split(' ').slice(1).join(' ') || ' ',
                },
                capabilities: {
                    transfers: { requested: true },
                },
                metadata: {
                    userId: req.userId.toString()
                }
            });

            // Guardar account ID
            await db.query(
                `UPDATE users SET stripeAccountId = ? WHERE id = ?`,
                [account.id, req.userId]
            );

            // Generar link de onboarding
            const accountLink = await stripe.accountLinks.create({
                account: account.id,
                refresh_url: `${process.env.FRONTEND_URL}/seller/bank-account`,
                return_url: `${process.env.FRONTEND_URL}/seller/bank-account/success`,
                type: 'account_onboarding',
            });

            console.log(`✅ [Sellers] Cuenta Stripe Connect creada para usuario ${req.userId}`);
            res.json({ 
                success: true, 
                url: accountLink.url,
                hasAccount: false
            });
        } catch (error) {
            console.error('❌ [Sellers] Error creando Stripe Connect:', error);
            res.status(500).json({ message: 'Error al crear cuenta Stripe: ' + error.message });
        }
    });

    // GET /api/sellers/stripe-connect-status - Obtener estado de onboarding de Stripe
    router.get('/stripe-connect-status', authenticateToken, isSeller, async (req, res) => {
        console.log(`🏦 [Sellers] Obteniendo estado de Stripe Connect para vendedor ${req.userId}`);

        try {
            const [user] = await db.query(
                `SELECT stripeAccountId, bankAccountStatus FROM users WHERE id = ?`,
                [req.userId]
            );

            if (!user[0]?.stripeAccountId) {
                return res.json({ 
                    hasAccount: false, 
                    isOnboarded: false,
                    chargesEnabled: false,
                    payoutsEnabled: false
                });
            }

            try {
                const account = await stripe.accounts.retrieve(user[0].stripeAccountId);
                
                res.json({
                    hasAccount: true,
                    isOnboarded: account.charges_enabled && account.payouts_enabled,
                    chargesEnabled: account.charges_enabled,
                    payoutsEnabled: account.payouts_enabled,
                    detailsSubmitted: account.details_submitted,
                    bankAccountStatus: user[0]?.bankAccountStatus || 'pending'
                });
            } catch (stripeError) {
                console.error('⚠️ [Sellers] Error obteniendo cuenta Stripe:', stripeError.message);
                res.json({ 
                    hasAccount: true, 
                    isOnboarded: false,
                    error: 'Error verificando estado'
                });
            }
        } catch (error) {
            console.error('❌ [Sellers] Error obteniendo estado Stripe:', error);
            res.status(500).json({ message: 'Error al obtener estado' });
        }
    });

    return router;
};