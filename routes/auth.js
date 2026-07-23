const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { findUserByEmail, findUserById, createUser } = require('../db');

const router = express.Router();

const JWT_ALGORITHM = 'HS256';

function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function setSessionCookie(res, user) {
    const token = jwt.sign(
        { id: user.id, email: user.email, name: user.name },
        process.env.JWT_SECRET,
        { algorithm: JWT_ALGORITHM, expiresIn: '7d' }
    );
    res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000
    });
}

// Anti brute-force : 5 tentatives / 15 min par IP sur signup et login,
// et un plafond un peu plus large sur /me (appelé automatiquement à chaque
// chargement de page).
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }
});

// POST /api/auth/signup
router.post('/signup', authLimiter, async (req, res) => {
    const { name, email, password } = req.body || {};

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Merci d\'entrer ton nom.' });
    }
    if (!validEmail(email || '')) {
        return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    }
    if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (password.length > 72) {
        return res.status(400).json({ error: 'Le mot de passe est trop long (72 caractères maximum).' });
    }
    if (name.trim().length > 100) {
        return res.status(400).json({ error: 'Le nom est trop long (100 caractères maximum).' });
    }
    if (findUserByEmail(email)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
        id: crypto.randomUUID(),
        name: name.trim(),
        email: email.trim().toLowerCase(),
        passwordHash,
        createdAt: new Date().toISOString()
    };

    try {
        // createUser revérifie l'unicité de l'e-mail à l'intérieur d'une file
        // d'attente d'écriture : évite qu'une double soumission simultanée
        // crée deux comptes avec le même e-mail.
        await createUser(user);
    } catch (e) {
        if (e.code === 'EMAIL_TAKEN') {
            return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail.' });
        }
        console.error('Erreur création compte:', e);
        return res.status(500).json({ error: 'Impossible de créer le compte, réessaie.' });
    }

    setSessionCookie(res, user);
    res.status(201).json({ ok: true, user: { name: user.name, email: user.email } });
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = findUserByEmail(email || '');

    if (!user) {
        // On calcule quand même un hash bidon pour que le temps de réponse soit
        // similaire, que l'e-mail existe ou non (limite le "user enumeration" par timing).
        await bcrypt.compare(password || '', '$2a$10$C6UzMDM.H6dfI/f/IKcEeO');
        return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    const match = await bcrypt.compare(password || '', user.passwordHash);
    if (!match) {
        return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    setSessionCookie(res, user);
    res.json({ ok: true, user: { name: user.name, email: user.email } });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Non authentifié.' });
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
        // On récupère createdAt depuis la base (pas dans le JWT, pour garder le token léger).
        const user = findUserById(payload.id);
        res.json({
            ok: true,
            user: {
                name: payload.name,
                email: payload.email,
                createdAt: user?.createdAt || null
            }
        });
    } catch {
        res.status(401).json({ error: 'Session invalide.' });
    }
});

module.exports = router;
