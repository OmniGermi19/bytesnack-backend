const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ message: 'No se proporcionó token de autenticación' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expirado' });
        }
        return res.status(403).json({ message: 'Token inválido' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de administrador.' });
    }
    next();
};

const isSeller = (req, res, next) => {
    if (req.userRole !== 'Vendedor' && req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de vendedor.' });
    }
    next();
};

const isBuyer = (req, res, next) => {
    if (req.userRole !== 'Comprador' && req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de comprador.' });
    }
    next();
};

const isOwnerOrAdmin = (req, res, next) => {
    const resourceUserId = parseInt(req.params.userId) || req.body.userId;
    if (req.userRole === 'Administrador' || req.userId === resourceUserId) {
        return next();
    }
    return res.status(403).json({ message: 'No tienes permiso para acceder a este recurso' });
};

const canCreateProduct = (req, res, next) => {
    if (req.userRole === 'Vendedor' || req.userRole === 'Administrador') {
        return next();
    }
    return res.status(403).json({ message: 'Solo los vendedores pueden crear productos' });
};

const canApproveProduct = (req, res, next) => {
    if (req.userRole === 'Administrador') {
        return next();
    }
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