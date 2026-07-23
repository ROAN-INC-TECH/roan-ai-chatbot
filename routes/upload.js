const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Anti-abus : chaque analyse de fichier a un coût (CPU, parsing PDF/Word...).
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Trop d'envois de fichiers, patiente un instant." }
});

// On garde le fichier en mémoire (pas d'écriture disque) puis on le jette après traitement.
// Limite relevée à 50 Mo pour permettre l'envoi de dossiers compressés (zip/rar/7z) de 25 Mo+.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 Mo max
});

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ARCHIVE_TYPES = [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/x-7z-compressed',
    'application/x-tar',
    'application/gzip',
    'application/x-gzip'
];
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz)$/i;
const MAX_EXTRACTED_CHARS = 12000; // on tronque le texte extrait pour rester raisonnable pour l'IA

// POST /api/upload  (protégé par requireAuth dans server.js)
router.post('/', uploadLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier reçu.' });
    }

    const { buffer, mimetype, originalname, size } = req.file;

    try {
        // --- CAS 1 : IMAGE (photo prise ou choisie dans la galerie) ---
        if (IMAGE_TYPES.includes(mimetype)) {
            const base64 = buffer.toString('base64');
            const dataUrl = `data:${mimetype};base64,${base64}`;
            return res.json({
                ok: true,
                type: 'image',
                name: originalname,
                size,
                dataUrl
            });
        }

        // --- CAS 2 : PDF ---
        if (mimetype === 'application/pdf') {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || '').trim().slice(0, MAX_EXTRACTED_CHARS);
            return res.json({
                ok: true,
                type: 'document',
                name: originalname,
                size,
                text: text || '(Aucun texte détecté dans ce PDF — peut-être un scan/image.)'
            });
        }

        // --- CAS 3 : WORD (.docx) ---
        if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            const text = (result.value || '').trim().slice(0, MAX_EXTRACTED_CHARS);
            return res.json({
                ok: true,
                type: 'document',
                name: originalname,
                size,
                text: text || '(Aucun texte détecté dans ce document.)'
            });
        }

        // --- CAS 4 : Texte brut / CSV / JSON / code ---
        if (mimetype.startsWith('text/') || ['application/json', 'application/csv'].includes(mimetype)) {
            const text = buffer.toString('utf-8').slice(0, MAX_EXTRACTED_CHARS);
            return res.json({
                ok: true,
                type: 'document',
                name: originalname,
                size,
                text
            });
        }

        // --- CAS 5 : dossier compressé (zip / rar / 7z / tar / gz) ---
        if (ARCHIVE_TYPES.includes(mimetype) || ARCHIVE_EXT.test(originalname)) {
            const sizeMb = (size / (1024 * 1024)).toFixed(1);
            let listing = '';

            // Pour les .zip, on tente de lister le contenu si le paquet "adm-zip" est disponible
            // (npm install adm-zip). Sinon on se contente des infos de base, sans planter.
            if (/\.zip$/i.test(originalname) || mimetype.includes('zip')) {
                try {
                    const AdmZip = require('adm-zip');
                    const zip = new AdmZip(buffer);
                    const entries = zip.getEntries().slice(0, 50);
                    listing = entries.map(en => `- ${en.entryName}`).join('\n');
                } catch (e) {
                    listing = ''; // adm-zip absent ou zip illisible : on ignore silencieusement
                }
            }

            const text = `[Dossier compressé "${originalname}", ${sizeMb} Mo]` +
                (listing ? `\nContenu détecté :\n${listing}` : '\n(Contenu non listé — fichier reçu et transmis tel quel.)');

            return res.json({
                ok: true,
                type: 'archive',
                name: originalname,
                size,
                text
            });
        }

        // --- CAS 6 : type non supporté pour l'extraction de texte ---
        return res.json({
            ok: true,
            type: 'unsupported',
            name: originalname,
            size,
            mimetype
        });

    } catch (err) {
        console.error('Erreur upload/analyse fichier:', err);
        res.status(500).json({ error: "Impossible d'analyser ce fichier." });
    }
});

// Gestion propre des erreurs Multer (ex: fichier > 50 Mo) : on répond en JSON
// plutôt que de laisser Express renvoyer une page d'erreur HTML brute.
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Fichier trop volumineux (limite : 50 Mo).' });
        }
        return res.status(400).json({ error: `Erreur d'envoi : ${err.message}` });
    }
    console.error('Erreur upload:', err);
    res.status(500).json({ error: "Erreur serveur lors de l'envoi du fichier." });
});

module.exports = router;
