const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'conversations.json');

// Limites pour éviter qu'un compte ne fasse gonfler le fichier indéfiniment
// (pas de vraie base de données ici, juste un fichier JSON plat).
const MAX_CONVERSATIONS_PER_USER = 200;
const MAX_BYTES_PER_USER = 8 * 1024 * 1024; // 8 Mo par utilisateur

function ensureDb() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2));
}

function readDb() {
    ensureDb();
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function writeDb(data) {
    const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, DB_PATH);
}

// Même principe de verrou d'écriture que db.js : sérialise les écritures
// pour éviter qu'une sync rapide (plusieurs onglets/appareils) ne s'écrase.
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
    const result = writeQueue.then(() => fn());
    writeQueue = result.catch(() => {});
    return result;
}

function getConversations(userId) {
    const db = readDb();
    const entry = db[userId];
    return entry?.conversations || [];
}

async function saveConversations(userId, conversations) {
    return withWriteLock(() => {
        const trimmed = Array.isArray(conversations) ? conversations.slice(0, MAX_CONVERSATIONS_PER_USER) : [];

        // Filet de sécurité côté taille : si jamais le payload dépasse la limite
        // (ex: beaucoup d'images en base64 dans l'historique), on retire les images
        // plutôt que de refuser toute la sync.
        let serialized = JSON.stringify(trimmed);
        if (Buffer.byteLength(serialized, 'utf-8') > MAX_BYTES_PER_USER) {
            trimmed.forEach(c => {
                (c.messages || []).forEach(m => {
                    if (Array.isArray(m.content)) {
                        m.content = m.content.filter(p => p.type !== 'image_url');
                    }
                });
            });
            serialized = JSON.stringify(trimmed);
        }

        const db = readDb();
        db[userId] = { conversations: trimmed, updatedAt: new Date().toISOString() };
        writeDb(db);
        return trimmed;
    });
}

async function deleteUserConversations(userId) {
    return withWriteLock(() => {
        const db = readDb();
        delete db[userId];
        writeDb(db);
    });
}

module.exports = { getConversations, saveConversations, deleteUserConversations };
