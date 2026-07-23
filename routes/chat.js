const express = require('express');
const router = express.Router();

// On ne garde que les N derniers messages envoyés à Mistral : évite qu'une
// conversation très longue (côté client, l'historique n'est jamais purgé)
// ne fasse gonfler le coût et la latence indéfiniment.
const MAX_HISTORY_MESSAGES = 24;
const MAX_TEXT_LENGTH = 20000; // par message texte
const MAX_TOOL_ROUNDS = 2; // jusqu'à 2 allers-retours d'outils par message (ex: recherche puis image), pour borner la latence

const STATUS_LABELS = {
    web_search: '🔎 Recherche sur le web…',
    wolfram_alpha: '🧮 Calcul en cours…',
    get_weather: '🌤️ Récupération de la météo…',
    generate_image: "🎨 Génération de l'image…"
};

function isValidRole(role) {
    return ['user', 'assistant', 'system'].includes(role);
}

// N'accepte que des images en data: URL (celles produites par notre propre
// /api/upload). Refuser les http(s)://... évite que ce endpoint ne serve de
// relais pour faire aller chercher une URL arbitraire par l'API Mistral (SSRF).
function isValidContentPart(part) {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.length <= MAX_TEXT_LENGTH;
    }
    if (part.type === 'image_url') {
        const url = part.image_url?.url;
        return typeof url === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(url);
    }
    return false;
}

function isValidMessage(m) {
    if (!m || typeof m !== 'object' || !isValidRole(m.role)) return false;
    if (typeof m.content === 'string') return m.content.length <= MAX_TEXT_LENGTH;
    if (Array.isArray(m.content)) return m.content.length > 0 && m.content.every(isValidContentPart);
    return false;
}

// Écrit un événement SSE. `event` est optionnel (sinon événement "message" par défaut).
function sendEvent(res, dataObj, event) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

// --- Fournisseurs d'IA disponibles. Mistral reste la base ; Groq est utilisé
// uniquement pour le mode "Rapide" quand une clé est configurée (inférence
// nettement plus rapide sur des modèles open-source comme Llama).
const PROVIDERS = {
    mistral: {
        baseUrl: 'https://api.mistral.ai/v1/chat/completions',
        apiKey: process.env.MISTRAL_API_KEY
    },
    groq: {
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: process.env.GROQ_API_KEY
    }
};

// --- Modèles disponibles, choisis depuis Paramètres > Modèle côté client ---
// La clé "image" est forcée automatiquement dès qu'un message contient une image,
// quel que soit le choix de l'utilisateur (Pixtral est le seul à "voir").
const MODEL_CONFIG = {
    balanced: { provider: 'mistral', model: process.env.MISTRAL_MODEL || 'mistral-large-latest' },
    fast: process.env.GROQ_API_KEY
        ? { provider: 'groq', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' }
        : { provider: 'mistral', model: process.env.MISTRAL_FAST_MODEL || 'mistral-small-latest' },
    code: { provider: 'mistral', model: process.env.MISTRAL_CODE_MODEL || 'codestral-latest' },
    image: { provider: 'mistral', model: process.env.MISTRAL_VISION_MODEL || 'pixtral-large-latest' }
};

// --- Outil "recherche web" exposé au modèle via function-calling. ---
// N'est proposé au modèle que si TAVILY_API_KEY est configurée ET que
// l'utilisateur a activé le bouton 🌐 côté client.
const WEB_SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'web_search',
        description: "Recherche des informations à jour sur le web (actualité, faits récents, données qui changent). " +
            "À utiliser quand la question porte sur quelque chose de récent ou susceptible d'avoir changé après la formation du modèle.",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Requête de recherche, en quelques mots-clés.' }
            },
            required: ['query']
        }
    }
};

async function runWebSearch(query) {
    if (!process.env.TAVILY_API_KEY || !query) {
        return JSON.stringify({ error: 'Recherche web non configurée côté serveur.' });
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        const r = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query,
                max_results: 5,
                include_answer: false
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!r.ok) return JSON.stringify({ error: 'La recherche web a échoué.' });
        const data = await r.json();
        const results = (data.results || []).slice(0, 5).map(item => ({
            title: item.title,
            url: item.url,
            content: (item.content || '').slice(0, 600)
        }));
        return JSON.stringify({ query, results });
    } catch (e) {
        return JSON.stringify({ error: 'La recherche web a échoué ou a pris trop de temps.' });
    }
}

// --- Outil "Wolfram Alpha" : calculs, maths, conversions, données scientifiques précises. ---
const WOLFRAM_TOOL = {
    type: 'function',
    function: {
        name: 'wolfram_alpha',
        description: "Calcule ou vérifie une réponse précise à une question mathématique, scientifique, " +
            "de conversion d'unités ou de données factuelles chiffrées (ex: \"racine carrée de 2\", " +
            "\"convertir 5 miles en km\", \"population du Japon\"). À privilégier plutôt que de calculer soi-même " +
            "dès qu'une précision exacte est importante.",
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'La question ou le calcul, en anglais de préférence (meilleurs résultats).' }
            },
            required: ['query']
        }
    }
};

async function runWolframAlpha(query) {
    if (!process.env.WOLFRAM_APP_ID || !query) {
        return JSON.stringify({ error: 'Wolfram Alpha non configuré côté serveur.' });
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const url = `https://api.wolframalpha.com/v1/result?appid=${process.env.WOLFRAM_APP_ID}&i=${encodeURIComponent(query)}`;
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!r.ok) return JSON.stringify({ error: "Wolfram Alpha n'a pas trouvé de réponse à cette question." });
        const answer = await r.text();
        return JSON.stringify({ query, answer });
    } catch (e) {
        return JSON.stringify({ error: 'Wolfram Alpha a échoué ou a pris trop de temps.' });
    }
}

// --- Outil "météo" : conditions actuelles pour une ville donnée. ---
const WEATHER_TOOL = {
    type: 'function',
    function: {
        name: 'get_weather',
        description: "Donne la météo actuelle (température, ressenti, conditions, humidité, vent) pour une ville précise.",
        parameters: {
            type: 'object',
            properties: {
                location: { type: 'string', description: 'Nom de la ville (et pays si ambigu), ex: "Paris", "Abidjan,CI".' }
            },
            required: ['location']
        }
    }
};

async function runWeather(location) {
    if (!process.env.OPENWEATHER_API_KEY || !location) {
        return JSON.stringify({ error: 'Météo non configurée côté serveur.' });
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric&lang=fr`;
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!r.ok) return JSON.stringify({ error: `Ville introuvable : ${location}` });
        const data = await r.json();
        return JSON.stringify({
            location: data.name,
            country: data.sys?.country,
            temp_c: data.main?.temp,
            feels_like_c: data.main?.feels_like,
            description: data.weather?.[0]?.description,
            humidity_percent: data.main?.humidity,
            wind_kmh: Math.round((data.wind?.speed || 0) * 3.6)
        });
    } catch (e) {
        return JSON.stringify({ error: 'La météo a échoué ou a pris trop de temps.' });
    }
}

// --- Outil "génération d'image" : via Pollinations.ai (gratuit, sans clé). ---
// Le tool ne génère rien lui-même : il renvoie une URL que Pollinations construit
// à la volée dès qu'elle est chargée par une balise <img>. On demande au modèle
// d'inclure cette URL sous forme d'image Markdown dans sa réponse finale.
const IMAGE_TOOL = {
    type: 'function',
    function: {
        name: 'generate_image',
        description: "Génère une image à partir d'une description. Utilise cet outil dès que l'utilisateur " +
            "demande explicitement une image, une illustration, un dessin ou une photo générée. " +
            "Après l'appel, inclue l'URL renvoyée dans ta réponse sous forme d'image Markdown : ![description](url).",
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: "Description détaillée de l'image à générer, en anglais de préférence." }
            },
            required: ['prompt']
        }
    }
};

function runGenerateImage(prompt) {
    if (!prompt) return JSON.stringify({ error: 'Aucune description fournie pour générer une image.' });
    const image_url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
    return JSON.stringify({ image_url, prompt });
}

// Exécute l'outil demandé par le modèle et renvoie toujours une chaîne (le
// contenu attendu pour un message de rôle "tool").
async function runTool(name, args) {
    switch (name) {
        case 'web_search': return runWebSearch(args.query);
        case 'wolfram_alpha': return runWolframAlpha(args.query);
        case 'get_weather': return runWeather(args.location);
        case 'generate_image': return runGenerateImage(args.prompt);
        default: return JSON.stringify({ error: `Outil inconnu : ${name}` });
    }
}

// Un seul appel Mistral en streaming. Relit le flux SSE "compatible OpenAI",
// relaie le texte au client au fur et à mesure, et accumule les éventuels
// tool_calls (function-calling) qui arrivent eux aussi en morceaux.
async function streamChatCall({ apiBase, apiKey, model, messages, tools, signal, onDelta }) {
    const apiRes = await fetch(apiBase, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            ...(tools ? { tools, tool_choice: 'auto' } : {})
        }),
        signal
    });

    if (!apiRes.ok || !apiRes.body) {
        let errMsg = "Erreur de l'API IA.";
        try {
            const errJson = await apiRes.json();
            errMsg = errJson.error?.message || errMsg;
        } catch { /* réponse non-JSON, on garde le message par défaut */ }
        const err = new Error(errMsg);
        err.isApiError = true;
        throw err;
    }

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let assistantText = '';
    const toolCallsAcc = {}; // index -> { id, name, arguments }
    let finishReason = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // dernière ligne potentiellement incomplète : on la garde pour la suite

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let json;
            try {
                json = JSON.parse(payload);
            } catch {
                continue; // fragment JSON non parsable (rare, coupure réseau) : on ignore ce morceau
            }

            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};

            if (delta.content) {
                assistantText += delta.content;
                onDelta(delta.content);
            }

            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', name: '', arguments: '' };
                    if (tc.id) toolCallsAcc[idx].id = tc.id;
                    if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
                    if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
                }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
        }
    }

    return { assistantText, toolCalls: Object.values(toolCallsAcc), finishReason };
}

// POST /api/chat  (protégé par requireAuth + chatLimiter dans server.js)
// Réponse en streaming (Server-Sent Events) : le client reçoit le texte au
// fur et à mesure, comme sur claude.ai, au lieu d'attendre la réponse complète.
router.post('/', async (req, res) => {
    const { messages: rawMessages, model: requestedModel, webSearch } = req.body || {};

    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
        return res.status(400).json({ error: 'Historique de conversation manquant.' });
    }

    if (!rawMessages.every(isValidMessage)) {
        return res.status(400).json({ error: 'Format de message invalide.' });
    }

    // Fenêtrage : on ne transmet que les derniers messages à l'IA.
    const messages = rawMessages.slice(-MAX_HISTORY_MESSAGES);

    // Si un message contient une image (content sous forme de tableau avec image_url),
    // on doit utiliser un modèle Mistral capable de "voir" (Pixtral), quel que soit le
    // modèle choisi par l'utilisateur dans Paramètres.
    const containsImage = messages.some(m =>
        Array.isArray(m.content) && m.content.some(part => part.type === 'image_url')
    );
    const model = containsImage
        ? MODEL_CONFIG.image
        : (MODEL_CONFIG[requestedModel] || MODEL_CONFIG.balanced);
    const provider = PROVIDERS[model.provider];

    // Les outils ne sont proposés au modèle que si le client a activé le
    // bouton 🛠️ Outils. La génération d'image ne nécessite pas de clé
    // (Pollinations est gratuit) ; les autres dépendent d'une clé configurée.
    const toolDefs = [];
    if (webSearch === true) {
        if (process.env.TAVILY_API_KEY) toolDefs.push(WEB_SEARCH_TOOL);
        if (process.env.WOLFRAM_APP_ID) toolDefs.push(WOLFRAM_TOOL);
        if (process.env.OPENWEATHER_API_KEY) toolDefs.push(WEATHER_TOOL);
        toolDefs.push(IMAGE_TOOL);
    }
    const tools = toolDefs.length ? toolDefs : undefined;

    // On bascule la réponse HTTP en flux SSE dès que la validation est passée.
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no' // désactive le buffering de certains proxys (nginx...)
    });

    // Si le client ferme la connexion (bouton "Stop", ou navigation), on annule
    // aussi l'appel en cours vers l'IA plutôt que de le laisser tourner.
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // On borne l'appel à 90s : si l'IA ne répond jamais, on referme proprement
    // plutôt que de laisser la connexion ouverte indéfiniment.
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
        let workingMessages = messages;
        let round = 0;

        while (true) {
            const { assistantText, toolCalls, finishReason } = await streamChatCall({
                apiBase: provider.baseUrl,
                apiKey: provider.apiKey,
                model: model.model,
                messages: workingMessages,
                tools,
                signal: controller.signal,
                onDelta: (text) => sendEvent(res, { delta: text })
            });

            const wantsTool = finishReason === 'tool_calls' && toolCalls.length > 0;

            if (!wantsTool || round >= MAX_TOOL_ROUNDS) {
                sendEvent(res, {}, 'done');
                return res.end();
            }

            // Le modèle veut utiliser un ou plusieurs outils : on prévient le
            // client (petit indicateur d'état), on les exécute, puis on relance
            // un appel avec les résultats pour obtenir la réponse finale.
            round++;
            sendEvent(res, { status: STATUS_LABELS[toolCalls[0].name] || "🛠️ Utilisation d'un outil…" }, 'status');

            const assistantToolMsg = {
                role: 'assistant',
                content: assistantText || null,
                tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments }
                }))
            };

            const toolResultMsgs = [];
            for (const tc of toolCalls) {
                let args = {};
                try { args = JSON.parse(tc.arguments || '{}'); } catch { /* arguments malformés : objet vide */ }
                const result = await runTool(tc.name, args);
                toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.name || 'outil', content: result });
            }

            workingMessages = [...workingMessages, assistantToolMsg, ...toolResultMsgs];
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            // Coupé par le timeout ou par le client (bouton Stop) : rien de plus à faire.
            return res.end();
        }
        console.error('Erreur proxy chat:', err);
        try {
            sendEvent(res, { error: err.isApiError ? err.message : 'Impossible de contacter le service IA.' }, 'error');
        } catch { /* la connexion est peut-être déjà fermée */ }
        res.end();
    } finally {
        clearTimeout(timeout);
    }
});

module.exports = router;
