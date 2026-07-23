require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const uploadRoutes = require('./routes/upload');
const conversationsRoutes = require('./routes/conversations');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (comme la plupart des hébergeurs) fait tourner l'app derrière un
// reverse proxy : sans ça, req.ip et les rate-limiters verraient l'IP du
// proxy au lieu de celle du vrai visiteur. Actif seulement en production.
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// En-têtes de sécurité de base (CSP désactivée par défaut car l'app utilise
// des styles/scripts inline ; à durcir si tu externalises le JS/CSS plus tard).
app.use(helmet({ contentSecurityPolicy: false }));

// Limite relevée car une image envoyée en base64 dans le JSON dépasse vite 100kb
// (les fichiers/archives passent eux par multer/multipart, cf. routes/upload.js)
app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());

// --- Anti-CSRF léger : sur les requêtes qui modifient un état (POST/PUT/PATCH/DELETE),
// on vérifie que l'Origin (ou à défaut le Referer) correspond bien à notre propre host.
// Le cookie de session est déjà en SameSite=Lax, ceci ajoute une deuxième barrière
// contre un site tiers qui essaierait de déclencher ces requêtes pour un utilisateur connecté.
function checkOrigin(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    const origin = req.headers.origin || req.headers.referer;
    if (!origin) return next(); // pas de header (ex: appel direct via curl/Postman) : on laisse passer

    try {
        const originHost = new URL(origin).host;
        if (originHost === req.headers.host) return next();
    } catch (e) { /* URL invalide, on tombe sur le refus ci-dessous */ }

    return res.status(403).json({ error: "Requête refusée (origine invalide)." });
}
app.use(checkOrigin);

// --- Health check (utile pour Render / un monitoring externe) ---
app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- API publique (inscription / connexion) ---
app.use('/api/auth', authRoutes);

// Anti-abus sur le chat : évite qu'un compte compromis (ou un script) ne brûle
// tout le quota Mistral en boucle. Ajuste la limite selon ton usage réel.
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de messages envoyés, patiente un instant.' }
});

// --- API protégée (chat IA) ---
app.use('/api/chat', requireAuth, chatLimiter, chatRoutes);

// --- API protégée (upload : photo caméra / galerie / fichiers) ---
app.use('/api/upload', requireAuth, uploadRoutes);

// --- API protégée (sync cloud des conversations) ---
const syncLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de synchronisations, patiente un instant.' }
});
app.use('/api/conversations', requireAuth, syncLimiter, conversationsRoutes);

// --- Page protégée : index.html nécessite d'être connecté ---
app.get(['/', '/index.html'], requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Fichiers statiques publics (signup.html, login.html, assets...) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- 404 pour tout le reste ---
app.use((req, res) => {
    if (req.accepts('html')) return res.status(404).sendFile(path.join(__dirname, 'public', 'login.html'));
    res.status(404).json({ error: 'Route introuvable.' });
});

// --- Filet de sécurité : capture toute erreur non gérée dans les routes
// pour ne jamais renvoyer une stack trace au client.
app.use((err, req, res, next) => {
    console.error('Erreur non gérée:', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
});

app.listen(PORT, () => {
    console.log(`✅ ROAN AI backend lancé sur http://localhost:${PORT}`);
});
