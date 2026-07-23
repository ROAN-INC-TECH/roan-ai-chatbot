# ROAN AI — Backend

Backend Node.js/Express pour ton app **ROAN AI** : inscription, connexion, sessions sécurisées, et proxy vers l'API Mistral (pour ne plus exposer ta clé API dans le navigateur).

## 🚀 Installation

```bash
cd roan-ai-backend
npm install
cp .env.example .env
```

Puis édite `.env` :
- `JWT_SECRET` → génère-en un avec `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `MISTRAL_API_KEY` → ta vraie clé Mistral (jamais dans le HTML !)

> ⚠️ Si ton fichier `.env` a un jour été partagé (zip, capture d'écran, dépôt public...),
> considère ses secrets comme compromis : régénère `JWT_SECRET` et ta clé Mistral.

## ▶️ Lancer le serveur

```bash
npm start
```

Va ensuite sur `http://localhost:3000/signup.html`.

## 📁 Structure

```
roan-ai-backend/
├── server.js           # point d'entrée Express
├── db.js                # stockage utilisateurs (fichier JSON, data/users.json)
├── middleware/auth.js    # vérifie le cookie de session (JWT)
├── routes/auth.js        # /api/auth/signup, /login, /logout, /me
├── routes/chat.js        # /api/chat (proxy sécurisé vers Mistral)
└── public/
    ├── signup.html        # inscription (thème bleu/blanc)
    ├── login.html          # connexion (thème bleu/blanc)
    └── index.html           # chat IA (protégé — redirige vers signup.html si non connecté)
```

## 🔒 Comment ça marche

1. `signup.html` envoie `POST /api/auth/signup` → le backend hache le mot de passe (bcrypt), crée l'utilisateur, et pose un cookie de session `httpOnly` (JWT).
2. `index.html` est protégé par le middleware `requireAuth` : si tu n'as pas de session valide, tu es renvoyé vers `signup.html` **côté serveur**, pas juste en JS.
3. Le chat appelle `POST /api/chat`, qui lui-même appelle Mistral **depuis le serveur** avec ta clé stockée dans `.env`. Ta clé n'apparaît donc plus jamais dans le code source vu par le navigateur.

## ⚠️ Sécurité

- Le fichier `data/users.json` sert de base de données simple pour démarrer. Pour un vrai déploiement, migre vers PostgreSQL/MongoDB.
- Ne commit jamais ton fichier `.env` (ajoute-le à `.gitignore`).
- Comme toujours avec tes bots Telegram/WhatsApp : si une clé ou un token a été exposé publiquement, régénère-le.
