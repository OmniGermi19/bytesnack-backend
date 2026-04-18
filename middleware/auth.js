const jwt = require('jsonwebtoken');

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: 'Token inválido' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.userRole !== 'Administrador') {
        return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }
    next();
};

const isSeller = (req, res, next) => {
    if (req.userRole !== 'Vendedor' && req.userRole !== 'Administrador') {
        return res.status(403).json({ success: false, message: 'Acceso denegado' });
    }
    next();
};

module.exports = { authenticateToken, isAdmin, isSeller };