const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'users.json');

function ensureDb() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2));
}

function readDb() {
    ensureDb();
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDb(data) {
    // Écriture atomique : on écrit dans un fichier temporaire puis on renomme.
    // Un rename est atomique au niveau du système de fichiers, ce qui évite
    // un users.json à moitié écrit si le process crash pendant l'écriture.
    const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, DB_PATH);
}

// File d'attente simple pour sérialiser les écritures : évite que deux
// inscriptions simultanées se marchent dessus (lecture-modification-écriture
// non atomique sur un fichier JSON plat).
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
    const result = writeQueue.then(() => fn());
    writeQueue = result.catch(() => {}); // on continue la queue même si une écriture échoue
    return result;
}

function findUserByEmail(email) {
    const db = readDb();
    return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
}

function findUserById(id) {
    const db = readDb();
    return db.users.find(u => u.id === id);
}

async function createUser(user) {
    return withWriteLock(() => {
        const db = readDb();
        // Double vérification à l'intérieur du verrou : évite une course où
        // deux requêtes passeraient toutes les deux le check "email déjà pris"
        // avant que l'une des deux n'écrive.
        if (db.users.find(u => u.email.toLowerCase() === user.email.toLowerCase())) {
            const err = new Error('EMAIL_TAKEN');
            err.code = 'EMAIL_TAKEN';
            throw err;
        }
        db.users.push(user);
        writeDb(db);
        return user;
    });
}

module.exports = { findUserByEmail, findUserById, createUser };
