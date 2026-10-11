# Kavryon — Local testing guide

## Prerequisites
- Node.js 18+ (20+ recommended)
- Optional: Android Studio + SDK 36 for APK

## 1. Install backend deps
```bash
cd backend
npm install
cd ..
```

## 2. Configure
```bash
cp .env.example .env
# Set JWT_SECRET to a long random string (32+ chars)
```

## 3. Start server
```bash
# Uses SQLite at /tmp/kavryon.sqlite by default (or KAVRYON_DB)
node backend/server.js
# → http://localhost:8080
```

## 4. Open the web app
Browser: `http://localhost:8080`

### Sign up (User A)
- Register a username + password
- Creator Mode is **free** for all users

### Play Crystal Siege
1. Home → Discover → open **Crystal Siege**
2. Play → join a server
3. Controls:
   - **A / D** or arrows: move
   - **W / Space**: jump
   - **J**: attack (destroy enemy crystal when close)
   - **E**: interact / open shop near shop object

### Create your own game
1. Create → pick template **BedWars** (or Empty World)
2. Edit objects in Studio → Save
3. Publish
4. Open a second browser (incognito) as User B → Discover → play

## 5. Run automated tests
```bash
npm test
```

## 6. Multiplayer local
Open two browsers, same published game, join the same server. Movement is server-authoritative.
