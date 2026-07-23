const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
    const token = req.cookies?.token;

    if (!token) {
        if (req.accepts('html')) return res.redirect('/signup.html');
        return res.status(401).json({ error: 'Non authentifié.' });
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        next();
    } catch (e) {
        res.clearCookie('token');
        if (req.accepts('html')) return res.redirect('/signup.html');
        return res.status(401).json({ error: 'Session invalide ou expirée.' });
    }
}

module.exports = { requireAuth };
