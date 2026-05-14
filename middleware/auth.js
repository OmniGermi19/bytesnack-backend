const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
        console.log('❌ [Auth] No se proporcionó token');
        return res.status(401).json({ message: 'No se proporcionó token de autenticación' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        console.log(`✅ [Auth] Usuario autenticado: ${req.userId} (${req.userRole})`);
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('❌ [Auth] Token expirado');
            return res.status(401).json({ message: 'Token expirado' });
        }
        console.log('❌ [Auth] Token inválido:', error.message);
        return res.status(403).json({ message: 'Token inválido' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.userRole !== 'Administrador') {
        console.log(`❌ [Auth] Acceso denegado: ${req.userRole} no es Administrador`);
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de administrador.' });
    }
    console.log(`✅ [Auth] Permiso de administrador concedido a ${req.userId}`);
    next();
};

const isSeller = (req, res, next) => {
    if (req.userRole !== 'Vendedor' && req.userRole !== 'Administrador') {
        console.log(`❌ [Auth] Acceso denegado: ${req.userRole} no es Vendedor`);
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de vendedor.' });
    }
    console.log(`✅ [Auth] Permiso de vendedor concedido a ${req.userId}`);
    next();
};

const isBuyer = (req, res, next) => {
    if (req.userRole !== 'Comprador' && req.userRole !== 'Administrador') {
        console.log(`❌ [Auth] Acceso denegado: ${req.userRole} no es Comprador`);
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de comprador.' });
    }
    console.log(`✅ [Auth] Permiso de comprador concedido a ${req.userId}`);
    next();
};

const isOwnerOrAdmin = (req, res, next) => {
    const resourceUserId = parseInt(req.params.userId) || req.body.userId;
    if (req.userRole === 'Administrador' || req.userId === resourceUserId) {
        console.log(`✅ [Auth] Propietario/Admin concedido a ${req.userId}`);
        return next();
    }
    console.log(`❌ [Auth] Acceso denegado: ${req.userId} no es propietario del recurso ${resourceUserId}`);
    return res.status(403).json({ message: 'No tienes permiso para acceder a este recurso' });
};

const canCreateProduct = (req, res, next) => {
    if (req.userRole === 'Vendedor' || req.userRole === 'Administrador') {
        console.log(`✅ [Auth] Permiso para crear producto concedido a ${req.userId}`);
        return next();
    }
    console.log(`❌ [Auth] Acceso denegado: ${req.userRole} no puede crear productos`);
    return res.status(403).json({ message: 'Solo los vendedores pueden crear productos' });
};

const canApproveProduct = (req, res, next) => {
    if (req.userRole === 'Administrador') {
        console.log(`✅ [Auth] Permiso para aprobar producto concedido a ${req.userId}`);
        return next();
    }
    console.log(`❌ [Auth] Acceso denegado: ${req.userRole} no puede aprobar productos`);
    return res.status(403).json({ message: 'Solo los administradores pueden aprobar productos' });
};

module.exports = {
    authenticateToken,
    isAdmin,
    isSeller,
    isBuyer,
    isOwnerOrAdmin,
    canCreateProduct,
    canApproveProduct
};