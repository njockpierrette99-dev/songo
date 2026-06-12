/**
 * SONGO — BACKEND DISTANT (Node.js / Express)
 * Architecture REST + Polling côté client
 *
 * Endpoints :
 *   POST /api/creer        — Créer une nouvelle partie (retourne gameId)
 *   POST /api/rejoindre    — Rejoindre une partie existante (retourne rôle J2)
 *   GET  /api/etat/:id     — Obtenir l'état courant d'une partie
 *   POST /api/coup         — Jouer un coup
 *
 * Stockage : en mémoire (Map JS) — adapté pour démo académique
 *
 * Installation :
 *   npm init -y
 *   npm install express cors
 *   node app.js
 *
 * Puis ouvrir index.html dans deux onglets/machines.
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Sert le front-end depuis /public

/* ============================================================
   STOCKAGE EN MÉMOIRE
   Map<gameId, EtatPartie>
============================================================ */
const parties = new Map();

/* ============================================================
   LOGIQUE MÉTIER DU JEU (même algorithmes que version locale)
============================================================ */

const CAMP_J1    = [7, 8, 9, 10, 11, 12, 13];
const CAMP_J2    = [0, 1, 2, 3, 4, 5, 6];
const SEQUENCE   = [13, 12, 11, 10, 9, 8, 7, 0, 1, 2, 3, 4, 5, 6];

function posSequence(idx)   { return SEQUENCE.indexOf(idx); }
function caseSuivante(idx)  { return SEQUENCE[(posSequence(idx) + 1) % 14]; }
function estCampJ1(idx)     { return CAMP_J1.includes(idx); }
function estCampJ2(idx)     { return CAMP_J2.includes(idx); }
function campAdverse(j)     { return j === 1 ? 2 : 1; }
function casesDuCamp(j)     { return j === 1 ? CAMP_J1 : CAMP_J2; }
function estDansCamp(idx,j) { return casesDuCamp(j).includes(idx); }
function totalCamp(pl, j)   { return casesDuCamp(j).reduce((s,i) => s+pl[i], 0); }

/** Algorithme de distribution anti-horaire */
function distribuer(caseDepart, plateau) {
  let pl  = [...plateau];
  let nb  = pl[caseDepart];
  if (nb === 0) return null;
  pl[caseDepart] = 0;
  
  let current       = caseDepart;
  let restantes     = nb;
  let tourComplet   = nb >= 13;
  
  while (restantes > 0) {
    current = caseSuivante(current);
    if (tourComplet && current === caseDepart) continue;
    pl[current]++;
    restantes--;
  }
  return { dernierCase: current, plateau: pl };
}

/** Algorithme de capture (2/3/4 graines dans camp adverse) */
function calculerCaptures(dernierCase, plateau, joueur) {
  const adverse = campAdverse(joueur);
  if (!estDansCamp(dernierCase, adverse)) {
    return { plateau, grainesCapturees: 0, casesCapturees: [] };
  }
  const premiereCaseAdverse = joueur === 1 ? 0 : 13;
  if (dernierCase === premiereCaseAdverse) {
    return { plateau, grainesCapturees: 0, casesCapturees: [] };
  }
  
  let pl = [...plateau];
  let total = 0;
  let casesCapturees = [];
  let caseEnCours = dernierCase;
  
  while (estDansCamp(caseEnCours, adverse)) {
    const nb = pl[caseEnCours];
    if (nb === 2 || nb === 3 || nb === 4) {
      total += nb;
      casesCapturees.push(caseEnCours);
      pl[caseEnCours] = 0;
    } else { break; }
    
    const posPrev = (posSequence(caseEnCours) - 1 + 14) % 14;
    const casePrev = SEQUENCE[posPrev];
    if (!estDansCamp(casePrev, adverse)) break;
    caseEnCours = casePrev;
  }
  
  return { plateau: pl, grainesCapturees: total, casesCapturees };
}

/** Règle de solidarité */
function verifierSolidarite(plateau, joueur) {
  const adverse = campAdverse(joueur);
  if (totalCamp(plateau, adverse) > 0) return { solidariteRequise: false };
  
  let meilleurCoup = null;
  let maxNourriture = 0;
  
  for (const ci of casesDuCamp(joueur)) {
    if (plateau[ci] === 0) continue;
    const res = distribuer(ci, plateau);
    if (!res) continue;
    const grainesAdv = totalCamp(res.plateau, adverse);
    if (grainesAdv > maxNourriture) {
      maxNourriture = grainesAdv;
      meilleurCoup = ci;
    }
  }
  
  if (maxNourriture === 0) {
    return { solidariteRequise: true, possible: false };
  }
  return { solidariteRequise: true, possible: true, coupObligatoire: meilleurCoup };
}

/** Vérification des conditions de fin */
function verifierFin(etatPartie) {
  const { plateau, scores, joueurActif } = etatPartie;
  const total = plateau.reduce((s,n) => s+n, 0);
  if (scores[0] >= 40) return { fin: true, raison: 'score', gagnant: 1 };
  if (scores[1] >= 40) return { fin: true, raison: 'score', gagnant: 2 };
  if (total < 10)       return { fin: true, raison: 'peu_graines' };
  const sol = verifierSolidarite(plateau, joueurActif);
  if (sol.solidariteRequise && !sol.possible)
    return { fin: true, raison: 'solidarite_impossible' };
  return { fin: false };
}

/** Créer un état initial de partie */
function creerEtatInitial() {
  return {
    plateau:       Array(14).fill(5),
    scores:        [0, 0],
    joueurActif:   1,
    joueurs:       { 1: null, 2: null }, // tokens des joueurs
    partieTerminee: false,
    finInfo:       null,
    dernierCoup:   null,
    timestamp:     Date.now()
  };
}

/* ============================================================
   ROUTES API
============================================================ */

/**
 * POST /api/creer
 * Corps : {}
 * Réponse : { gameId, token, joueur: 1 }
 */
app.post('/api/creer', (req, res) => {
  const gameId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const token  = crypto.randomBytes(8).toString('hex');
  
  const etatPartie = creerEtatInitial();
  etatPartie.joueurs[1] = token;
  
  parties.set(gameId, etatPartie);
  
  console.log(`[CREER] Partie ${gameId} créée.`);
  res.json({ gameId, token, joueur: 1 });
});

/**
 * POST /api/rejoindre
 * Corps : { gameId }
 * Réponse : { token, joueur: 2 } ou erreur
 */
app.post('/api/rejoindre', (req, res) => {
  const { gameId } = req.body;
  if (!gameId) return res.status(400).json({ erreur: 'gameId manquant' });
  
  const partie = parties.get(gameId);
  if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });
  if (partie.joueurs[2]) return res.status(409).json({ erreur: 'Partie complète' });
  
  const token = crypto.randomBytes(8).toString('hex');
  partie.joueurs[2] = token;
  
  console.log(`[REJOINDRE] Joueur 2 a rejoint la partie ${gameId}.`);
  res.json({ token, joueur: 2 });
});

/**
 * GET /api/etat/:gameId
 * Réponse : état complet de la partie (sans tokens secrets)
 */
app.get('/api/etat/:gameId', (req, res) => {
  const { gameId } = req.params;
  const partie = parties.get(gameId);
  if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });
  
  // Ne pas exposer les tokens
  const { joueurs, ...etatPublic } = partie;
  const joueur2Present = !!joueurs[2];
  
  res.json({ ...etatPublic, joueur2Present });
});

/**
 * POST /api/coup
 * Corps : { gameId, token, caseIdx }
 * Réponse : nouvel état ou erreur
 */
app.post('/api/coup', (req, res) => {
  const { gameId, token, caseIdx } = req.body;
  
  if (!gameId || !token || caseIdx === undefined) {
    return res.status(400).json({ erreur: 'Paramètres manquants' });
  }
  
  const partie = parties.get(gameId);
  if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });
  if (partie.partieTerminee) return res.status(400).json({ erreur: 'Partie terminée' });
  
  // Vérifier le token du joueur
  const joueur = partie.joueurs[1] === token ? 1
               : partie.joueurs[2] === token ? 2
               : null;
  if (!joueur) return res.status(403).json({ erreur: 'Token invalide' });
  
  // Vérifier que c'est le bon tour
  if (joueur !== partie.joueurActif) {
    return res.status(400).json({ erreur: 'Ce n\'est pas votre tour' });
  }
  
  const idx = parseInt(caseIdx, 10);
  
  // Vérifier appartenance de la case
  if (!estDansCamp(idx, joueur)) {
    return res.status(400).json({ erreur: 'Case hors de votre camp' });
  }
  if (partie.plateau[idx] === 0) {
    return res.status(400).json({ erreur: 'Case vide' });
  }
  
  // Vérifier la solidarité
  const sol = verifierSolidarite(partie.plateau, joueur);
  if (sol.solidariteRequise && sol.possible) {
    const simul = distribuer(idx, partie.plateau);
    if (simul && totalCamp(simul.plateau, campAdverse(joueur)) === 0) {
      return res.status(400).json({ erreur: 'Solidarité : vous devez nourrir l\'adversaire' });
    }
  }
  
  // Distribution
  const resDistrib = distribuer(idx, partie.plateau);
  if (!resDistrib) return res.status(400).json({ erreur: 'Distribution impossible' });
  
  let nouveauPlateau = resDistrib.plateau;
  
  // Captures
  const resCaptures = calculerCaptures(resDistrib.dernierCase, nouveauPlateau, joueur);
  nouveauPlateau = resCaptures.plateau;
  
  // Scores
  partie.scores[joueur - 1] += resCaptures.grainesCapturees;
  partie.plateau = nouveauPlateau;
  
  // Tour suivant
  partie.joueurActif = joueur === 1 ? 2 : 1;
  partie.dernierCoup = {
    joueur,
    caseIdx: idx,
    grainesCapturees: resCaptures.grainesCapturees,
    casesCapturees: resCaptures.casesCapturees
  };
  partie.timestamp = Date.now();
  
  // Fin de partie ?
  const finCheck = verifierFin(partie);
  if (finCheck.fin) {
    partie.partieTerminee = true;
    partie.finInfo = finCheck;
  }
  
  console.log(`[COUP] Partie ${gameId} | J${joueur} joue case ${idx} | Captures: ${resCaptures.grainesCapturees}`);
  
  const { joueurs, ...etatPublic } = partie;
  res.json({ ...etatPublic, joueur2Present: !!joueurs[2] });
});

/* ============================================================
   NETTOYAGE DES PARTIES INACTIVES (> 2h)
============================================================ */
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, p] of parties.entries()) {
    if (p.timestamp < limite) {
      parties.delete(id);
      console.log(`[NETTOYAGE] Partie ${id} supprimée.`);
    }
  }
}, 15 * 60 * 1000);

/* ============================================================
   DÉMARRAGE
============================================================ */
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  SONGO Backend  —  Port ${PORT}          ║`);
  console.log(`║  Ouvrez public/index.html             ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
});