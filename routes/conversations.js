const express = require('express');
const router = express.Router();
const { getConversations, saveConversations } = require('../conversationsDb');

const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 20000;

function isValidContentPart(part) {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text') return typeof part.text === 'string';
    if (part.type === 'image_url') {
        const url = part.image_url?.url;
        return typeof url === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(url);
    }
    return false;
}

function isValidMessage(m) {
    if (!m || typeof m !== 'object' || !['user', 'assistant', 'system'].includes(m.role)) return false;
    if (typeof m.content === 'string') return m.content.length <= MAX_TEXT_LENGTH;
    if (Array.isArray(m.content)) return m.content.every(isValidContentPart);
    return false;
}

function isValidConversation(c) {
    return c && typeof c === 'object' &&
        typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 100 &&
        typeof c.title === 'string' && c.title.length <= MAX_TITLE_LENGTH &&
        Array.isArray(c.messages) && c.messages.every(isValidMessage) &&
        typeof c.updatedAt === 'number';
}

// GET /api/conversations — récupère toutes les conversations sync du compte connecté
router.get('/', (req, res) => {
    const conversations = getConversations(req.user.id);
    res.json({ ok: true, conversations });
});

// PUT /api/conversations — remplace l'intégralité des conversations du compte
// (le client envoie toujours son état complet ; dernier écrit gagne).
router.put('/', async (req, res) => {
    const { conversations } = req.body || {};

    if (!Array.isArray(conversations)) {
        return res.status(400).json({ error: 'Format invalide.' });
    }
    if (!conversations.every(isValidConversation)) {
        return res.status(400).json({ error: 'Une ou plusieurs conversations sont invalides.' });
    }

    try {
        const saved = await saveConversations(req.user.id, conversations);
        res.json({ ok: true, count: saved.length });
    } catch (err) {
        console.error('Erreur sync conversations:', err);
        res.status(500).json({ error: 'Impossible de synchroniser les conversations.' });
    }
});

module.exports = router;
