// assistant.js – Module de recherche de performances (classe, professeur ou élève)
import {
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// -------------------------------------------------------------
// CACHE (indexé par userId)
// -------------------------------------------------------------
const DATA_CACHE_TTL = 15 * 60 * 1000;
const cacheByUser = new Map();

function getUserCache(userId) {
  if (!cacheByUser.has(userId)) {
    cacheByUser.set(userId, {
      classes:           null, classesCacheTime:    0,
      evals:             null, evalsCacheTime:       0,
      allEleves:         null, allElevesCacheTime:   0,
      elevesByClasse:    {},   // { [classeId]: { data, time } }
      notesByEval:       {},   // { [evalId]:   { data, time } }
    });
  }
  return cacheByUser.get(userId);
}

// ---- Sessions menu interactif ----
const userSessions = new Map();

// -------------------------------------------------------------
// UTILITAIRES
// -------------------------------------------------------------
function normalizeString(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeUserMessage(msg) {
  let n = msg.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const synonymMap = {
    'élève':'eleve','étudiant':'eleve','etudiant':'eleve',
    'notes':'eleve','note':'eleve','bulletin':'eleve','prof':'professeur',
  };
  for (const [w, r] of Object.entries(synonymMap))
    n = n.replace(new RegExp(`\\b${w}\\b`, 'gi'), r);

  const useless = [
    'quels sont','quel est','montre moi','montre-moi','affiche',
    'je veux','je voudrais','veuillez','merci','s il te plait',
    's il vous plait','stp','svp','donne moi','donne-moi',
    'les','la','le','des','de','du','resultats','résultats',
  ];
  useless.forEach(p => n = n.replace(new RegExp(`\\b${p}\\b`, 'gi'), ' '));
  n = n.replace(/\s+/g, ' ').trim();

  const targets = ['eleve','classe','professeur'];
  let bestIdx = -1, bestKw = null;
  for (const kw of targets) {
    const idx = n.indexOf(kw);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestKw = kw; }
  }
  if (bestKw) n = n.substring(bestIdx);
  return n.replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------------
// FONCTION PRINCIPALE
// -------------------------------------------------------------
export default async function assistant(message, userId, db) {
  const rawMessage = message.trim();
  if (!userId) return "❌ Utilisateur non identifié. Veuillez vous reconnecter.";
  if (!db)     return "❌ Base de données non disponible. Veuillez recharger la page.";

  const norm = normalizeUserMessage(rawMessage);

  // ---- Aide ----
  if (norm === '/aide' || norm === 'aide') {
    return `Commandes disponibles :

// Élève
- <strong>eleve</strong> [nom] : Voir les notes et la moyenne d'un élève.
- <strong>donne moi les notes de</strong> [nom]
- <strong>je veux les résultats de</strong> [nom]

// Professeur
- <strong>professeur</strong> [nom] : Stats d'un professeur.
- <strong>donne moi le bilan du professeur</strong> [nom]

// Rapport classe
- <strong>rapport classe</strong> [nom] : Rapport détaillé d'une classe.
- <strong>montre moi le rapport de la classe</strong> [nom]
- <strong>je veux voir le bilan de la classe</strong> [nom]

// Rapport élève
- <strong>rapport eleve</strong> [nom] : Rapport pédagogique individuel.
- <strong>montre-moi le rapport de l'élève</strong> [nom]
- <strong>je veux voir le bilan de l'élève</strong> [nom]`;
  }

  // ---- Patterns ----
  const patterns = [
    {
      regex: /(?:rapport|bilan|résultats?|performances?)\s+(?:de\s+)?(?:la\s+)?classe\s+(?:de\s+)?(.*)/i,
      handler: async (name) => {
        if (!name.trim()) return "❓ Précisez le nom de la classe (ex: rapport classe 5e A).";
        return await handleClassReport(db, name.trim(), userId);
      }
    },
    {
      regex: /(?:rapport|bilan|suivi|performances?)\s+(?:de\s+)?(?:l'?)?(?:élève|eleve|etudiant)s?\s+(?:de\s+)?(.*)/i,
      handler: async (name) => {
        if (!name.trim()) return "❓ Précisez le nom de l'élève (ex: rapport eleve Rose Lopy).";
        return await handleStudentReport(db, name.trim(), userId);
      }
    },
    {
      regex: /(?:notes?|résultats?|bulletin|eleve)\s+(?:de\s+)?(.*)/i,
      handler: async (name) => {
        if (!name.trim()) return "❓ Précisez le nom de l'élève (ex: eleve Moussa).";
        return await handleStudentSearch(db, name.trim(), userId);
      }
    },
    {
      regex: /professeur\s+(.*)/i,
      handler: async (name) => {
        if (!name.trim()) return "❓ Précisez le nom du professeur (ex: professeur Amadou Diop).";
        return await handleProfessorByName(db, name.trim(), userId);
      }
    },
    {
      regex: /(?:performance|perf|stat)s?\s+(.*)/i,
      handler: async (term) => {
        if (!term.trim()) return "❓ Précisez un terme (classe, professeur, etc.).";
        return await handlePerformance(db, term.trim(), userId);
      }
    }
  ];

  for (const pattern of patterns) {
    const match = rawMessage.match(pattern.regex);
    if (match) {
      userSessions.delete(userId);
      return await pattern.handler(match[1]);
    }
  }

  // ---- Menu interactif ----
  const session = userSessions.get(userId);

  if (rawMessage.toLowerCase() === 'annuler' || rawMessage.toLowerCase() === 'cancel') {
    userSessions.delete(userId);
    return "❌ Menu annulé. Tapez `aide` pour voir les commandes.";
  }

  if (!session) {
    userSessions.set(userId, { waitingFor: 'choice' });
    return `❓ Commande non reconnue. Choisissez une option :

1️⃣ Voir les notes d'un élève
2️⃣ Voir les résultats d'un professeur
3️⃣ Voir le rapport d'une classe
4️⃣ Voir le rapport d'un élève

Tapez le chiffre correspondant (1-4) ou "annuler" pour quitter.`;
  }

  if (session.waitingFor === 'choice') {
    const choice = parseInt(rawMessage, 10);
    if (isNaN(choice) || choice < 1 || choice > 4)
      return `❌ Choix invalide. Tapez 1, 2, 3 ou 4 (ou "annuler").`;
    session.waitingFor = 'name';
    session.selectedOption = choice;
    userSessions.set(userId, session);
    const prompts = { 1:"Nom de l'élève :", 2:"Nom du professeur :", 3:"Nom de la classe :", 4:"Nom de l'élève :" };
    return `📝 ${prompts[choice]}`;
  }

  if (session.waitingFor === 'name') {
    const name = rawMessage.trim();
    if (!name) return "❌ Le nom ne peut pas être vide. Tapez 'annuler' pour quitter.";
    let result;
    try {
      switch (session.selectedOption) {
        case 1: result = await handleStudentSearch(db, name, userId);   break;
        case 2: result = await handleProfessorByName(db, name, userId); break;
        case 3: result = await handleClassReport(db, name, userId);     break;
        case 4: result = await handleStudentReport(db, name, userId);   break;
        default: result = "❌ Erreur interne.";
      }
    } catch (e) { console.error(e); result = "❌ Une erreur est survenue."; }
    userSessions.delete(userId);
    return result;
  }

  return "❓ Commande non reconnue. Tapez 'aide' pour voir les options.";
}

// -------------------------------------------------------------
// CACHE — CLASSES (filtrées par createdBy)
// -------------------------------------------------------------
async function getAllClasses(db, userId) {
  const uc = getUserCache(userId);
  if (uc.classes && Date.now() - uc.classesCacheTime < DATA_CACHE_TTL) return uc.classes;
  const snap = await getDocs(query(collection(db, 'classes'), where('createdBy', '==', userId)));
  uc.classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.classesCacheTime = Date.now();
  return uc.classes;
}

// -------------------------------------------------------------
// CACHE — EVALUATIONS (filtrées par createdBy)
// Structure : evaluations/{evalId}  avec champs matiere/matiereNom, classeId, professeurId, etc.
// -------------------------------------------------------------
async function getAllEvaluations(db, userId) {
  const uc = getUserCache(userId);
  if (uc.evals && Date.now() - uc.evalsCacheTime < DATA_CACHE_TTL) return uc.evals;
  const snap = await getDocs(query(collection(db, 'evaluations'), where('createdBy', '==', userId)));
  uc.evals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.evalsCacheTime = Date.now();
  return uc.evals;
}

// -------------------------------------------------------------
// CACHE — NOTES depuis evaluations/{evalId}/notes
// Chaque note contient : eleveId, note (number)
// -------------------------------------------------------------
async function getNotesByEval(db, evalId, userId) {
  const uc = getUserCache(userId);
  const cached = uc.notesByEval[evalId];
  if (cached && Date.now() - cached.time < DATA_CACHE_TTL) return cached.data;

  const snap = await getDocs(collection(db, 'evaluations', evalId, 'notes'));
  const notes = snap.docs.map(d => ({ id: d.id, evalId, ...d.data() }));
  uc.notesByEval[evalId] = { data: notes, time: Date.now() };
  return notes;
}

/**
 * Récupère toutes les notes d'un élève en parcourant toutes les évaluations.
 * Retourne un tableau de { evalId, matiere, note, professeurNom, classeId }
 */
async function getAllNotesForEleve(db, eleveId, userId) {
  const evals = await getAllEvaluations(db, userId);
  const result = [];

  await Promise.all(evals.map(async (ev) => {
    const notes = await getNotesByEval(db, ev.id, userId);
    const noteEleve = notes.find(n => n.eleveId === eleveId);
    if (noteEleve) {
      result.push({
        evalId:       ev.id,
        matiere:      ev.matiereNom || ev.matiere || ev.nomMatiere || "Matière inconnue",
        note:         Number(noteEleve.note || noteEleve.valeur),
        professeurNom: ev.professeurNom || "Inconnu",
        classeId:     ev.classeId || null,
      });
    }
  }));

  return result;
}

/**
 * Récupère toutes les notes d'une classe entière :
 * pour chaque évaluation qui concerne cette classe → toutes ses notes.
 * Retourne { [eleveId]: [ { matiere, note } ] }
 */
async function getAllNotesForClasse(db, classeId, userId) {
  const evals = await getAllEvaluations(db, userId);

  // On garde uniquement les évaluations de cette classe
  const evalsClasse = evals.filter(ev => ev.classeId === classeId);

  // Map evalId → matière
  const evalInfoMap = new Map();
  evalsClasse.forEach(ev => evalInfoMap.set(ev.id, {
    matiere:       ev.matiereNom || ev.matiere || ev.nomMatiere || "Inconnue",
    professeurNom: ev.professeurNom || "Inconnu",
  }));

  // Récupérer toutes les notes de ces évaluations
  const notesByEleve = {}; // { [eleveId]: [ { matiere, note, professeurNom } ] }

  await Promise.all(evalsClasse.map(async (ev) => {
    const notes = await getNotesByEval(db, ev.id, userId);
    const info  = evalInfoMap.get(ev.id);
    notes.forEach(n => {
      const val = Number(n.note || n.valeur);
      if (!n.eleveId || isNaN(val)) return;
      if (!notesByEleve[n.eleveId]) notesByEleve[n.eleveId] = [];
      notesByEleve[n.eleveId].push({
        matiere:       info.matiere,
        note:          val,
        professeurNom: info.professeurNom,
      });
    });
  }));

  return notesByEleve;
}

// -------------------------------------------------------------
// CACHE — ÉLÈVES depuis classes/{classeId}/eleves (sous-collection)
// -------------------------------------------------------------
async function getElevesByClasse(db, classeId, userId) {
  const uc = getUserCache(userId);
  const cached = uc.elevesByClasse[classeId];
  if (cached && Date.now() - cached.time < DATA_CACHE_TTL) return cached.data;

  const snap = await getDocs(collection(db, 'classes', classeId, 'eleves'));
  const eleves = snap.docs.map(d => ({ id: d.id, classeId, ...d.data() }));
  uc.elevesByClasse[classeId] = { data: eleves, time: Date.now() };
  return eleves;
}

async function getAllEleves(db, userId) {
  const uc = getUserCache(userId);
  if (uc.allEleves && Date.now() - uc.allElevesCacheTime < DATA_CACHE_TTL) return uc.allEleves;

  const classes  = await getAllClasses(db, userId);
  const allEleves = [];
  await Promise.all(classes.map(async (cl) => {
    const eleves = await getElevesByClasse(db, cl.id, userId);
    allEleves.push(...eleves);
  }));

  uc.allEleves = allEleves;
  uc.allElevesCacheTime = Date.now();
  return uc.allEleves;
}

// -------------------------------------------------------------
// RECHERCHE ÉLÈVE — BULLETIN
// -------------------------------------------------------------
async function handleStudentSearch(db, searchTerm, userId) {
  const ns = normalizeString(searchTerm);
  try {
    const eleves = await getAllEleves(db, userId);
    const found  = eleves.find(e => {
      const p = normalizeString(e.prenom || '');
      const n = normalizeString(e.nom    || '');
      return (p+' '+n).includes(ns) || (n+' '+p).includes(ns) || p.includes(ns) || n.includes(ns);
    });
    if (!found) return `😕 Impossible de trouver l'élève "${searchTerm}".`;

    const notesEleve = await getAllNotesForEleve(db, found.id, userId);
    if (notesEleve.length === 0)
      return `🎓 <strong>${found.prenom} ${found.nom}</strong>\n📭 Aucune note trouvée pour cet élève.`;

    let total = 0, count = 0, bulletin = [];
    notesEleve.forEach(({ matiere, note }) => {
      if (!isNaN(note)) {
        bulletin.push(`- <strong>${matiere}</strong> : ${note}/20`);
        total += note; count++;
      }
    });
    if (count === 0) return `🎓 <strong>${found.prenom} ${found.nom}</strong>\nAucune note valide trouvée.`;

    const moyenne = (total / count).toFixed(2);
    return `🎓 <strong>Bulletin de ${found.prenom} ${found.nom}</strong>\n\n` +
           `${bulletin.join('\n')}\n\n` +
           `📊 <strong>Moyenne Générale : ${moyenne}/20</strong>`;

  } catch (e) { console.error(e); return "❌ Erreur lors de la recherche des notes de l'élève."; }
}

// -------------------------------------------------------------
// PERFORMANCES / PROFS
// -------------------------------------------------------------
async function handlePerformance(db, term, userId) {
  const evals = await getAllEvaluations(db, userId);
  const evalsClasse = evals.filter(ev => {
    const nom = normalizeString(ev.classeNom || ev.nomClasse || '');
    return nom.includes(normalizeString(term));
  });
  if (evalsClasse.length > 0) {
    let sum = 0, count = 0;
    evalsClasse.forEach(ev => { sum += Number(ev.moyenneClasse) || 0; count++; });
    return `La classe <strong>${term}</strong> obtient une moyenne de ${(sum/count).toFixed(2)}/20 sur ${count} évaluations.`;
  }

  const profInfo = await findProfessorInClasses(db, term, userId);
  if (profInfo) return await handleProfessorById(db, profInfo.professeurId, profInfo.professeurNom, userId);

  return `😕 Aucune donnée pour "${term}".`;
}

async function findProfessorInClasses(db, searchTerm, userId) {
  const classes = await getAllClasses(db, userId);
  const ns = normalizeString(searchTerm);
  for (const cls of classes) {
    if (cls.matieres) {
      for (const m of cls.matieres) {
        if (m.professeurNom && normalizeString(m.professeurNom).includes(ns))
          return { professeurId: m.professeurId, professeurNom: m.professeurNom };
      }
    }
  }
  // Chercher aussi directement dans les évaluations
  const evals = await getAllEvaluations(db, userId);
  for (const ev of evals) {
    if (ev.professeurNom && normalizeString(ev.professeurNom).includes(ns))
      return { professeurId: ev.professeurId, professeurNom: ev.professeurNom };
  }
  return null;
}

async function handleProfessorById(db, profId, profNom = null, userId) {
  const evals = await getAllEvaluations(db, userId);
  const profEvals = evals.filter(ev => ev.professeurId === profId);
  if (profEvals.length === 0) return `👨 Professeur ${profNom || profId} : Aucune évaluation.`;
  let sum = 0, count = 0;
  profEvals.forEach(ev => { sum += Number(ev.moyenneClasse) || 0; count++; });
  const name = profNom || profEvals[0].professeurNom || profId;
  return `Le professeur <strong>${name}</strong> a une moyenne globale de ${(sum/count).toFixed(2)}/20 sur ${count} évaluations.`;
}

async function handleProfessorByName(db, name, userId) {
  const profInfo = await findProfessorInClasses(db, name, userId);
  if (!profInfo) return `😕 Aucun professeur trouvé avec le nom "${name}".`;
  return await handleProfessorById(db, profInfo.professeurId, profInfo.professeurNom, userId);
}

// -------------------------------------------------------------
// RAPPORT COMPLET D'UNE CLASSE
// -------------------------------------------------------------
async function handleClassReport(db, classeNom, userId) {
  try {
    const classes = await getAllClasses(db, userId);
    const classe = classes.find(c => {
      const nomBD   = normalizeString(c.nomClasse || c.classeNom || "");
      const nomUser = normalizeString(classeNom);
      return nomBD === nomUser || nomBD.replace(/\s/g,"") === nomUser.replace(/\s/g,"") || nomBD.includes(nomUser);
    });
    if (!classe) return `😕 Classe "${classeNom}" introuvable. Vérifiez le nom.`;

    const classeId = classe.id;
    const matieres = classe.matieres || [];

    // Élèves depuis la sous-collection
    const eleves = await getElevesByClasse(db, classeId, userId);
    if (eleves.length === 0) return `📚 Classe <strong>${classeNom}</strong>\nAucun élève inscrit dans cette classe.`;

    // ✅ Notes depuis evaluations/{evalId}/notes filtrées par classeId
    const notesByEleve = await getAllNotesForClasse(db, classeId, userId);

    // Construire les stats par élève
    const elevesWithNotes = eleves.map(eleve => {
      const notesEleve = notesByEleve[eleve.id] || [];
      let total = 0, count = 0;
      const notesParsed = [];
      notesEleve.forEach(({ matiere, note, professeurNom }) => {
        if (!isNaN(note)) {
          notesParsed.push({ matiere, valeur: note, professeurNom });
          total += note; count++;
        }
      });
      return {
        id: eleve.id, prenom: eleve.prenom||"", nom: eleve.nom||"",
        notes: notesParsed,
        moyenne: count > 0 ? total / count : 0,
        nbNotes: count
      };
    });

    const elevesAvecNotes = elevesWithNotes.filter(e => e.nbNotes > 0);
    if (elevesAvecNotes.length === 0) return `📚 Classe <strong>${classeNom}</strong>\nAucun élève n'a de notes enregistrées.`;

    const moyennesEleves = elevesAvecNotes.map(e => e.moyenne);
    const classeMoyenne  = moyennesEleves.reduce((a,b) => a+b, 0) / moyennesEleves.length;
    const faible = moyennesEleves.filter(m => m < 10).length;
    const moyen  = moyennesEleves.filter(m => m >= 10 && m <= 12).length;
    const fort   = moyennesEleves.filter(m => m > 12).length;

    const sorted  = [...elevesAvecNotes].sort((a,b) => b.moyenne - a.moyenne);
    const top3    = sorted.slice(0, 3);
    const bottom3 = sorted.slice(-3).reverse();

    // Stats par matière
    const matiereMap = new Map();
    elevesAvecNotes.forEach(eleve => {
      eleve.notes.forEach(n => {
        if (!matiereMap.has(n.matiere)) {
          const matInfo = matieres.find(m => m.nom === n.matiere || m.matiereNom === n.matiere);
          matiereMap.set(n.matiere, { total:0, count:0, professeur: n.professeurNom || matInfo?.professeurNom || "Inconnu" });
        }
        const entry = matiereMap.get(n.matiere);
        entry.total += n.valeur; entry.count++;
      });
    });

    const matiereStats = [];
    for (const [matiere, data] of matiereMap.entries()) {
      const moy = data.total / data.count;
      matiereStats.push({
        matiere, moyenne: moy.toFixed(2),
        classement: moy < 10 ? "Faible" : moy <= 12 ? "Suffisant" : "Très bien",
        professeur: data.professeur
      });
    }

    const generateBar = (value, max=20, length=20) => {
      const filled = Math.round((value/max)*length);
      return '█'.repeat(Math.max(0,filled)) + '░'.repeat(Math.max(0,length-filled));
    };

    // ---- Construction du rapport ----
    let rapport = `📋 <strong>Rapport pédagogique – Classe ${classeNom}</strong>\n\n`;
    const indice = classeMoyenne < 10 ? "⚠️ Niveau critique" : classeMoyenne <= 12 ? "📈 Niveau intermédiaire" : "🏆 Niveau d'excellence";
    rapport += `<strong>${indice}</strong> – `;

    const introFaible = [
      () => `La classe ${classeNom} présente des résultats préoccupants, avec une moyenne générale de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Les performances globales sont alarmantes : seuls ${fort} élèves dépassent la moyenne sur ${elevesAvecNotes.length} évalués. `,
      () => `L'analyse révèle une situation critique : la moyenne s'établit à ${classeMoyenne.toFixed(2)}/20, bien en deçà des attentes. `
    ];
    const introMoyen = [
      () => `La classe ${classeNom} obtient une moyenne de ${classeMoyenne.toFixed(2)}/20, un niveau correct mais perfectible. `,
      () => `Les résultats sont satisfaisants (${classeMoyenne.toFixed(2)}/20) mais des efforts restent à fournir. `,
      () => `Avec ${fort} élèves au-dessus de 12 et ${faible} en difficulté, la classe affiche une marge de progression. `
    ];
    const introExcellent = [
      () => `La classe ${classeNom} se distingue par d'excellents résultats, avec une moyenne de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Les performances sont remarquables : ${fort} élèves dépassent les 12/20, pour une moyenne de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Félicitations à tous : la moyenne de ${classeMoyenne.toFixed(2)}/20 reflète un travail de qualité. `
    ];

    const introArr = classeMoyenne < 10 ? introFaible : classeMoyenne <= 12 ? introMoyen : introExcellent;
    rapport += introArr[Math.floor(Math.random() * introArr.length)]();
    rapport += `Sur ${eleves.length} élèves, ${elevesAvecNotes.length} ont participé aux évaluations. `;
    rapport += `Répartition : ${faible} en dessous de 10, ${moyen} entre 10 et 12, ${fort} au‑delà de 12.\n\n`;

    const totalAN = elevesAvecNotes.length;
    rapport += `📊 <strong>Répartition visuelle des niveaux</strong>\n`;
    rapport += `Faibles (<10)  : ${generateBar(faible, totalAN)} ${faible}/${totalAN}\n`;
    rapport += `Moyens (10-12) : ${generateBar(moyen,  totalAN)} ${moyen}/${totalAN}\n`;
    rapport += `Forts (>12)    : ${generateBar(fort,   totalAN)} ${fort}/${totalAN}\n\n`;

    const topPhrases    = [() => `Les trois meilleurs éléments sont `, () => `En tête de classement, on retrouve `, () => `Les élèves les plus performants sont `];
    const bottomPhrases = [() => `À l'opposé, les élèves nécessitant un soutien prioritaire sont `, () => `En queue de peloton, on note `, () => `Les résultats les plus fragiles concernent `];

    if (top3.length > 0) {
      rapport += topPhrases[Math.floor(Math.random() * topPhrases.length)]();
      const tl = top3.map(e => `${e.prenom} ${e.nom} (${e.moyenne.toFixed(2)})`).join(', ');
      rapport += tl + '. ';
      if (top3.length >= 2 && top3[0].moyenne - top3[1].moyenne > 3) rapport += `Un écart significatif sépare le premier de ses poursuivants. `;
    }
    if (bottom3.length > 0) {
      rapport += bottomPhrases[Math.floor(Math.random() * bottomPhrases.length)]();
      rapport += bottom3.map(e => `${e.prenom} ${e.nom} (${e.moyenne.toFixed(2)})`).join(', ') + '. ';
      if (bottom3.some(e => e.moyenne < 8)) rapport += `Plusieurs sont très en difficulté et nécessitent une prise en charge rapide. `;
    }
    rapport += `\n\n`;

    if (matiereStats.length > 0) {
      rapport += `📚 <strong>Performances détaillées par matière</strong>\n`;
      const maxM = Math.max(...matiereStats.map(m => m.matiere.length));
      const maxP = Math.max(...matiereStats.map(m => m.professeur.length));
      for (const m of matiereStats) {
        rapport += `${m.matiere.padEnd(maxM)} (${m.professeur.padEnd(maxP)}) : ${generateBar(parseFloat(m.moyenne))} ${m.moyenne}/20 – ${m.classement}\n`;
      }
      rapport += `\n`;
      rapport += `L'examen par discipline fait ressortir : `;
      for (const m of matiereStats) {
        const appr = m.classement === "Faible" ? "nettement insuffisante" : m.classement === "Suffisant" ? "juste acceptable" : "tout à fait satisfaisante";
        rapport += `En ${m.matiere} (${m.professeur}), la moyenne de ${m.moyenne}/20 est ${appr}. `;
        if (m.classement === "Faible") rapport += `Un soutien ciblé est nécessaire. `;
        else if (m.classement === "Très bien") rapport += `Félicitations au professeur. `;
      }
    } else {
      rapport += `Aucune donnée par matière disponible. `;
    }
    rapport += `\n\n`;

    const tresBien   = matiereStats.filter(m => m.classement === "Très bien");
    const faiblesMat = matiereStats.filter(m => m.classement === "Faible");
    const recos = [];
    if (faiblesMat.length > 0) recos.push(faiblesMat.length === 1
      ? `Plan de remédiation impératif en ${faiblesMat[0].matiere} (tutorat, groupes de besoin).`
      : `Coordination nécessaire entre les enseignants de ${faiblesMat.map(m=>m.matiere).join(', ')} pour un plan de rattrapage.`
    );
    if (tresBien.length > 0) recos.push(`Valoriser les résultats en ${tresBien.map(m=>m.matiere).join(', ')} et encourager le partage de bonnes pratiques.`);
    if (faible > elevesAvecNotes.length * 0.3) recos.push(`Plus de 30% d'élèves en difficulté : une réunion pédagogique s'impose.`);
    else if (fort > elevesAvecNotes.length * 0.4) recos.push(`La dynamique positive peut être exploitée pour des projets interdisciplinaires.`);
    else recos.push(`La répartition équilibrée est un atout ; différencier les activités selon les besoins.`);

    rapport += `<strong>Recommandations :</strong> ${recos.join(' ')}\n\n`;

    rapport += `<strong>Conclusion.</strong> `;
    if (classeMoyenne < 10) rapport += `Ce rapport met en évidence une situation critique. Une stratégie de remédiation et un suivi individualisé sont indispensables.`;
    else if (classeMoyenne <= 12) rapport += `Les résultats sont encourageants mais perfectibles. Un accompagnement ciblé permettra d'élever le niveau général.`;
    else rapport += `Les résultats sont remarquables. Maintenez cette dynamique en encourageant l'excellence.`;
    rapport += ` Un suivi régulier des indicateurs permettra d'ajuster les actions pédagogiques.`;

    return rapport;

  } catch (e) {
    console.error("Erreur dans handleClassReport:", e);
    return "❌ Erreur lors de la génération du rapport de classe.";
  }
}

// -------------------------------------------------------------
// RAPPORT INDIVIDUEL D'UN ÉLÈVE
// -------------------------------------------------------------
async function handleStudentReport(db, searchTerm, userId) {
  try {
    const eleves = await getAllEleves(db, userId);
    const ns = normalizeString(searchTerm);
    const found = eleves.find(e => {
      const p = normalizeString(e.prenom || '');
      const n = normalizeString(e.nom    || '');
      return (p+' '+n).includes(ns) || (n+' '+p).includes(ns) || p.includes(ns) || n.includes(ns);
    });
    if (!found) return `😕 Impossible de trouver l'élève "${searchTerm}".`;

    const classes   = await getAllClasses(db, userId);
    const classe    = classes.find(c => c.id === found.classeId);
    const classeNom = classe ? (classe.nomClasse || classe.classeNom || "Inconnue") : "Inconnue";

    // ✅ Notes depuis evaluations/{evalId}/notes
    const notesEleve = await getAllNotesForEleve(db, found.id, userId);
    if (notesEleve.length === 0)
      return `📋 <strong>${found.prenom} ${found.nom}</strong> (${classeNom})\n📭 Aucune note enregistrée.`;

    const matiereNotes = new Map();
    let totalGeneral = 0, nbNotes = 0;

    notesEleve.forEach(({ matiere, note }) => {
      if (isNaN(note)) return;
      if (!matiereNotes.has(matiere)) matiereNotes.set(matiere, []);
      matiereNotes.get(matiere).push(note);
      totalGeneral += note; nbNotes++;
    });

    if (nbNotes === 0) return `📋 <strong>${found.prenom} ${found.nom}</strong> (${classeNom})\n📭 Aucune note valide trouvée.`;

    const moyenneGenerale = totalGeneral / nbNotes;
    const matieresStats = [], fortes = [], moyennes = [], faibles = [];

    for (const [matiere, notes] of matiereNotes.entries()) {
      const moy = notes.reduce((a,b) => a+b, 0) / notes.length;
      matieresStats.push({ matiere, moyenne: moy, nbNotes: notes.length });
      if (moy >= 13) fortes.push({ matiere, moyenne: moy });
      else if (moy >= 10) moyennes.push({ matiere, moyenne: moy });
      else faibles.push({ matiere, moyenne: moy });
    }

    const profil = moyenneGenerale < 10 ? "faible" : moyenneGenerale <= 12 ? "moyen" : "bon";

    const generateBar = (value, max=20, length=20) => {
      const filled = Math.round((value/max)*length);
      return '█'.repeat(Math.max(0,filled)) + '░'.repeat(Math.max(0,length-filled));
    };

    let rapport = `📋 <strong>Rapport pédagogique – ${found.prenom} ${found.nom}</strong>\n`;
    rapport += `Classe : <strong>${classeNom}</strong>\n\n`;

    const introFaible = [
      () => `${found.prenom} présente des résultats préoccupants avec une moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Les performances de ${found.prenom} sont insuffisantes : ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Avec ${moyenneGenerale.toFixed(2)}/20, ${found.prenom} se situe en dessous du seuil de réussite. `
    ];
    const introMoyen = [
      () => `${found.prenom} obtient ${moyenneGenerale.toFixed(2)}/20, un niveau correct mais perfectible. `,
      () => `Les résultats de ${found.prenom} sont satisfaisants (${moyenneGenerale.toFixed(2)}/20) mais des progrès sont possibles. `,
      () => `Avec ${fortes.length} matière(s) forte(s) et ${faibles.length} faible(s), ${found.prenom} affiche ${moyenneGenerale.toFixed(2)}/20. `
    ];
    const introBon = [
      () => `${found.prenom} se distingue avec une excellente moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Les performances de ${found.prenom} sont remarquables : ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Félicitations à ${found.prenom} pour sa moyenne de ${moyenneGenerale.toFixed(2)}/20. `
    ];

    const introArr = profil === "faible" ? introFaible : profil === "moyen" ? introMoyen : introBon;
    rapport += introArr[Math.floor(Math.random() * introArr.length)]();
    rapport += `Évalué(e) dans ${matieresStats.length} matière(s). `;
    rapport += `Fortes (≥13) : ${fortes.length} ; moyennes (10-12) : ${moyennes.length} ; faibles (<10) : ${faibles.length}.\n\n`;

    rapport += `📚 <strong>Détail par matière</strong>\n`;
    const maxLen = Math.max(...matieresStats.map(m => m.matiere.length));
    for (const m of matieresStats.sort((a,b) => b.moyenne - a.moyenne)) {
      rapport += `${m.matiere.padEnd(maxLen)} : ${generateBar(m.moyenne)} ${m.moyenne.toFixed(2)}/20 (${m.nbNotes} note(s))\n`;
    }
    rapport += `\n`;

    if (fortes.length > 0)  rapport += `✅ <strong>Points forts</strong> : ${fortes.map(f => `${f.matiere} (${f.moyenne.toFixed(2)})`).join(', ')}\n`;
    if (faibles.length > 0) rapport += `⚠️ <strong>Points faibles</strong> : ${faibles.map(f => `${f.matiere} (${f.moyenne.toFixed(2)})`).join(', ')}\n`;
    rapport += `\n`;

    const recoFaible = [
      "Soutien ciblé dans les matières sous la moyenne.",
      "Tutorat par un pair ou un enseignant pour les notions fondamentales.",
      "Entretien avec les parents pour définir un plan de remédiation.",
      "Exercices supplémentaires et suivi renforcé."
    ];
    const recoMoyen = [
      "Consolider les acquis par des exercices d'approfondissement.",
      "Encourager la participation orale pour gagner en confiance.",
      "Travailler la méthodologie pour transformer les 12 en 14.",
      "Fixer des objectifs progressifs dans les matières faibles."
    ];
    const recoBon = [
      "Proposer des projets avancés ou des défis académiques.",
      "Préparer l'élève à des concours ou options d'excellence.",
      "Mentorat pour partager ses méthodes de travail.",
      "Approfondissement autonome dans les matières de prédilection."
    ];

    const recos = (profil === "faible" ? [...recoFaible] : profil === "moyen" ? [...recoMoyen] : [...recoBon])
      .sort(() => Math.random() - 0.5);
    rapport += `🎯 <strong>Recommandations</strong> :\n`;
    recos.slice(0, 3).forEach(r => rapport += `- ${r}\n`);
    rapport += `\n`;

    rapport += `📝 <strong>Conclusion</strong> : `;
    if (profil === "faible") rapport += `La situation de ${found.prenom} nécessite une intervention rapide. Un accompagnement personnalisé et un dialogue avec la famille sont essentiels.`;
    else if (profil === "moyen") rapport += `${found.prenom} dispose d'une base solide. Avec plus d'investissement, le cap des 12 peut être dépassé.`;
    else rapport += `Félicitations à ${found.prenom} pour ces excellents résultats. Il/elle est invité(e) à maintenir cette dynamique.`;

    return rapport;

  } catch (e) {
    console.error("Erreur dans handleStudentReport:", e);
    return "❌ Erreur lors de la génération du rapport individuel.";
  }
}

