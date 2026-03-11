// assistant.js – Module de recherche de performances (classe, professeur ou élève)
import {
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// -------------------------------------------------------------
// CONSTANTES ET CACHE
// -------------------------------------------------------------
const CACHE_TTL = 5 * 60 * 1000;
const DATA_CACHE_TTL = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 100;

const cache = new Map();

// Les caches sont maintenant indexés par userId pour éviter les mélanges
const cacheByUser = new Map(); // clé = userId, valeur = { classes, evals, eleves, timestamps }

const COMMAND_SYNONYMS = ["performance", "perf", "stat"];
const ELEVE_SYNONYMS = ["eleve", "élève", "notes", "note", "bulletin", "etudiant"];

// ---- Session utilisateur pour le menu interactif ----
const userSessions = new Map();

// -------------------------------------------------------------
// UTILITAIRES
// -------------------------------------------------------------
function normalizeString(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function setCache(key, data) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = Array.from(cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

function getUserCache(userId) {
  if (!cacheByUser.has(userId)) {
    cacheByUser.set(userId, {
      classes: null, classesCacheTime: 0,
      evals: null,   evalsCacheTime: 0,
      eleves: null,  elevesCacheTime: 0,
    });
  }
  return cacheByUser.get(userId);
}

/**
 * Normalise un message utilisateur.
 */
function normalizeUserMessage(msg) {
  let normalized = msg
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const synonymMap = {
    'élève': 'eleve',
    'étudiant': 'eleve',
    'etudiant': 'eleve',
    'notes': 'eleve',
    'note': 'eleve',
    'bulletin': 'eleve',
    'prof': 'professeur',
  };
  for (const [word, replacement] of Object.entries(synonymMap)) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    normalized = normalized.replace(regex, replacement);
  }

  const useless = [
    'quels sont', 'quel est', 'montre moi', 'montre-moi', 'affiche',
    'je veux', 'je voudrais', 'veuillez', 'merci', 's il te plait',
    's il vous plait', 'stp', 'svp', 'donne moi', 'donne-moi',
    'les', 'la', 'le', 'des', 'de', 'du',
    'resultats', 'résultats',
  ];
  useless.forEach(phrase => {
    const regex = new RegExp(`\\b${phrase}\\b`, 'gi');
    normalized = normalized.replace(regex, ' ');
  });

  normalized = normalized.replace(/\s+/g, ' ').trim();

  const targetKeywords = ['eleve', 'classe', 'professeur'];
  let bestIndex = -1;
  let bestKeyword = null;
  for (const kw of targetKeywords) {
    const idx = normalized.indexOf(kw);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
      bestKeyword = kw;
    }
  }
  if (bestKeyword !== null) {
    normalized = normalized.substring(bestIndex);
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------------
// FONCTION PRINCIPALE — reçoit maintenant userId en paramètre
// -------------------------------------------------------------
export default async function assistant(message, userId, db) {
  const rawMessage = message.trim();

  // Vérification défensive
  if (!userId) {
    return "❌ Utilisateur non identifié. Veuillez vous reconnecter.";
  }
  if (!db) {
    return "❌ Base de données non disponible. Veuillez recharger la page.";
  }

  const normalizedMessage = normalizeUserMessage(rawMessage);

  // ---- Aide ----
  if (normalizedMessage === '/aide' || normalizedMessage === 'aide') {
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

// Rapport élève
- <strong>rapport eleve</strong> [nom] : Rapport pédagogique individuel.
- <strong>montre-moi le rapport de l'élève</strong> [nom]`;
  }

  // ---- Détection des commandes par motifs ----
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
    if (isNaN(choice) || choice < 1 || choice > 4) {
      return `❌ Choix invalide. Tapez 1, 2, 3 ou 4 (ou "annuler").`;
    }
    session.waitingFor = 'name';
    session.selectedOption = choice;
    userSessions.set(userId, session);

    const prompts = {
      1: "Veuillez entrer le nom de l'élève :",
      2: "Veuillez entrer le nom du professeur :",
      3: "Veuillez entrer le nom de la classe :",
      4: "Veuillez entrer le nom de l'élève :"
    };
    return `📝 ${prompts[choice]}`;
  }

  if (session.waitingFor === 'name') {
    const name = rawMessage.trim();
    if (!name) return "❌ Le nom ne peut pas être vide. Veuillez réessayer ou tapez 'annuler'.";

    let result;
    try {
      switch (session.selectedOption) {
        case 1: result = await handleStudentSearch(db, name, userId); break;
        case 2: result = await handleProfessorByName(db, name, userId); break;
        case 3: result = await handleClassReport(db, name, userId); break;
        case 4: result = await handleStudentReport(db, name, userId); break;
        default: result = "❌ Erreur interne.";
      }
    } catch (error) {
      console.error(error);
      result = "❌ Une erreur est survenue lors du traitement.";
    }

    userSessions.delete(userId);
    return result;
  }

  return "❓ Commande non reconnue. Tapez 'aide' pour voir les options.";
}

// -------------------------------------------------------------
// GESTION DES CACHES — filtrés par userId
// -------------------------------------------------------------

async function getAllClasses(db, userId) {
  const uc = getUserCache(userId);
  if (uc.classes && Date.now() - uc.classesCacheTime < DATA_CACHE_TTL) return uc.classes;

  const q = query(collection(db, 'classes'), where('createdBy', '==', userId));
  const snap = await getDocs(q);
  uc.classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.classesCacheTime = Date.now();
  return uc.classes;
}

async function getAllEvaluations(db, userId) {
  const uc = getUserCache(userId);
  if (uc.evals && Date.now() - uc.evalsCacheTime < DATA_CACHE_TTL) return uc.evals;

  const q = query(collection(db, 'evaluations'), where('createdBy', '==', userId));
  const snap = await getDocs(q);
  uc.evals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.evalsCacheTime = Date.now();
  return uc.evals;
}

async function getAllEleves(db, userId) {
  const uc = getUserCache(userId);
  if (uc.eleves && Date.now() - uc.elevesCacheTime < DATA_CACHE_TTL) return uc.eleves;

  const q = query(collection(db, 'eleves'), where('createdBy', '==', userId));
  const snap = await getDocs(q);
  uc.eleves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.elevesCacheTime = Date.now();
  return uc.eleves;
}

// -------------------------------------------------------------
// LOGIQUE ÉLÈVE
// -------------------------------------------------------------
async function handleStudentSearch(db, searchTerm, userId) {
  const normalizedSearch = normalizeString(searchTerm);

  try {
    const eleves = await getAllEleves(db, userId);
    let foundStudent = null;

    for (const eleve of eleves) {
      const prenomNorm = normalizeString(eleve.prenom || '');
      const nomNorm    = normalizeString(eleve.nom    || '');
      const fullName1  = prenomNorm + ' ' + nomNorm;
      const fullName2  = nomNorm + ' ' + prenomNorm;

      if (
        fullName1.includes(normalizedSearch) ||
        fullName2.includes(normalizedSearch) ||
        prenomNorm.includes(normalizedSearch) ||
        nomNorm.includes(normalizedSearch)
      ) {
        foundStudent = eleve;
        break;
      }
    }

    if (!foundStudent) return `😕 Impossible de trouver l'élève "${searchTerm}".`;

    const notesQuery = query(
      collection(db, 'notes'),
      where('eleveId', '==', foundStudent.id),
      where('createdBy', '==', userId)
    );
    const notesSnap = await getDocs(notesQuery);

    if (notesSnap.empty) {
      return `🎓 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong>\n📭 Aucune note trouvée pour cet élève.`;
    }

    let total = 0, count = 0;
    let bulletin = [];

    notesSnap.forEach(noteDoc => {
      const noteData = noteDoc.data();
      const val = Number(noteData.note || noteData.valeur);
      const matiere = noteData.matiere || "Matière inconnue";
      if (!isNaN(val)) {
        bulletin.push(`- <strong>${matiere}</strong> : ${val}/20`);
        total += val;
        count++;
      }
    });

    if (count === 0) {
      return `🎓 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong>\nAucune note valide trouvée.`;
    }

    const moyenne = (total / count).toFixed(2);
    return `🎓 <strong>Bulletin de ${foundStudent.prenom} ${foundStudent.nom}</strong>\n\n` +
           `${bulletin.join('\n')}\n\n` +
           `📊 <strong>Moyenne Générale : ${moyenne}/20</strong>`;

  } catch (error) {
    console.error(error);
    return "❌ Erreur lors de la recherche des notes de l'élève.";
  }
}

// -------------------------------------------------------------
// PERFORMANCES / PROFS
// -------------------------------------------------------------
async function handlePerformance(db, term, userId) {
  const classSnapshot = await getDocs(
    query(collection(db, 'evaluations'),
      where('classeNom', '==', term),
      where('createdBy', '==', userId)
    )
  );
  if (!classSnapshot.empty) return formatClassStats(term, classSnapshot);

  const professorInfo = await findProfessorInClasses(db, term, userId);
  if (professorInfo) return await handleProfessorById(db, professorInfo.professeurId, professorInfo.professeurNom, userId);

  return `😕 Aucune donnée pour "${term}".`;
}

async function findProfessorInClasses(db, searchTerm, userId) {
  const classes = await getAllClasses(db, userId);
  const normalizedSearch = normalizeString(searchTerm);
  for (const cls of classes) {
    if (cls.matieres) {
      for (const m of cls.matieres) {
        if (m.professeurNom && normalizeString(m.professeurNom).includes(normalizedSearch)) {
          return { professeurId: m.professeurId, professeurNom: m.professeurNom };
        }
      }
    }
  }
  return null;
}

async function handleProfessorById(db, profId, profNom = null, userId) {
  const snap = await getDocs(
    query(collection(db, 'evaluations'),
      where('professeurId', '==', profId),
      where('createdBy', '==', userId)
    )
  );
  if (snap.empty) return `👨 Professeur ${profNom || profId} : Aucune évaluation.`;

  let sum = 0, count = 0;
  snap.forEach(d => { sum += Number(d.data().moyenneClasse) || 0; count++; });
  const name = profNom || snap.docs[0].data().professeurNom || profId;
  return `Le professeur <strong>${name}</strong> a une moyenne globale de ${(sum / count).toFixed(2)}/20 sur ${count} évaluations.`;
}

async function handleProfessorByName(db, name, userId) {
  const professorInfo = await findProfessorInClasses(db, name, userId);
  if (!professorInfo) return `😕 Aucun professeur trouvé avec le nom "${name}".`;
  return await handleProfessorById(db, professorInfo.professeurId, professorInfo.professeurNom, userId);
}

function formatClassStats(className, snapshot) {
  let sum = 0, count = 0;
  snapshot.forEach(doc => { sum += Number(doc.data().moyenneClasse) || 0; count++; });
  return `La classe <strong>${className}</strong> obtient une moyenne de ${(sum / count).toFixed(2)}/20 sur ${count} évaluations.`;
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
      return (
        nomBD === nomUser ||
        nomBD.replace(/\s/g, "") === nomUser.replace(/\s/g, "") ||
        nomBD.includes(nomUser)
      );
    });

    if (!classe) return `😕 Classe "${classeNom}" introuvable. Vérifiez le nom.`;

    const classeId = classe.id;
    const matieres = classe.matieres || [];

    // Élèves de cette classe
    const elevesQuery = query(
      collection(db, 'eleves'),
      where('classeId', '==', classeId),
      where('createdBy', '==', userId)
    );
    const elevesSnap = await getDocs(elevesQuery);
    const eleves = elevesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (eleves.length === 0) {
      return `📚 Classe <strong>${classeNom}</strong>\nAucun élève inscrit dans cette classe.`;
    }

    // Map evaluations
    const allEvals = await getAllEvaluations(db, userId);
    const evalMap = new Map();
    allEvals.forEach(e => evalMap.set(e.id, e.matiereNom || e.matiere || "Inconnue"));

    // Notes par élève
    const elevesWithNotes = await Promise.all(eleves.map(async (eleve) => {
      const notesQuery = query(
        collection(db, 'notes'),
        where('eleveId', '==', eleve.id),
        where('createdBy', '==', userId)
      );
      const notesSnap = await getDocs(notesQuery);
      let notes = [], total = 0, count = 0;

      notesSnap.forEach(doc => {
        const noteData = doc.data();
        const val = Number(noteData.note || noteData.valeur);
        if (!isNaN(val)) {
          const matiere = evalMap.get(noteData.evaluationId) || noteData.matiere || "Inconnue";
          notes.push({ matiere, valeur: val });
          total += val;
          count++;
        }
      });

      return {
        id: eleve.id,
        prenom: eleve.prenom || "",
        nom: eleve.nom || "",
        notes,
        moyenne: count > 0 ? total / count : 0,
        nbNotes: count
      };
    }));

    const elevesAvecNotes = elevesWithNotes.filter(e => e.nbNotes > 0);
    if (elevesAvecNotes.length === 0) {
      return `📚 Classe <strong>${classeNom}</strong>\nAucun élève n'a de notes enregistrées.`;
    }

    // Statistiques globales
    const moyennesEleves = elevesAvecNotes.map(e => e.moyenne);
    const classeMoyenne  = moyennesEleves.reduce((a, b) => a + b, 0) / moyennesEleves.length;
    const faible = moyennesEleves.filter(m => m < 10).length;
    const moyen  = moyennesEleves.filter(m => m >= 10 && m <= 12).length;
    const fort   = moyennesEleves.filter(m => m > 12).length;

    const sorted  = [...elevesAvecNotes].sort((a, b) => b.moyenne - a.moyenne);
    const top3    = sorted.slice(0, 3);
    const bottom3 = sorted.slice(-3).reverse();

    // Stats par matière
    const matiereMap = new Map();
    elevesAvecNotes.forEach(eleve => {
      eleve.notes.forEach(n => {
        if (!matiereMap.has(n.matiere)) {
          const matInfo = matieres.find(m => m.nom === n.matiere || m.matiereNom === n.matiere);
          matiereMap.set(n.matiere, { total: 0, count: 0, professeur: matInfo?.professeurNom || "Inconnu" });
        }
        const entry = matiereMap.get(n.matiere);
        entry.total += n.valeur;
        entry.count++;
      });
    });

    const matiereStats = [];
    for (const [matiere, data] of matiereMap.entries()) {
      const moy = data.total / data.count;
      matiereStats.push({
        matiere,
        moyenne: moy.toFixed(2),
        classement: moy < 10 ? "Faible" : moy <= 12 ? "Suffisant" : "Très bien",
        professeur: data.professeur
      });
    }

    const generateBar = (value, max = 20, length = 20) => {
      const filled = Math.round((value / max) * length);
      return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, length - filled));
    };

    let rapport = `📋 <strong>Rapport pédagogique – Classe ${classeNom}</strong>\n\n`;

    let indiceGlobal = classeMoyenne < 10 ? "⚠️ Niveau critique" : classeMoyenne <= 12 ? "📈 Niveau intermédiaire" : "🏆 Niveau d'excellence";
    rapport += `<strong>${indiceGlobal}</strong> – `;

    const introFaible    = [
      () => `La classe ${classeNom} présente des résultats préoccupants, avec une moyenne générale de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Les performances globales sont alarmantes : seuls ${fort} élèves dépassent la moyenne sur ${elevesAvecNotes.length} évalués. `,
    ];
    const introMoyen     = [
      () => `La classe ${classeNom} obtient une moyenne générale de ${classeMoyenne.toFixed(2)}/20, un niveau correct mais perfectible. `,
      () => `Avec ${fort} élèves au-dessus de 12 et ${faible} en difficulté, la classe affiche une marge de progression. `,
    ];
    const introExcellent = [
      () => `La classe ${classeNom} se distingue par d'excellents résultats, avec une moyenne générale de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Les performances sont remarquables : ${fort} élèves dépassent les 12/20 pour une moyenne de ${classeMoyenne.toFixed(2)}/20. `,
    ];

    let intros = classeMoyenne < 10 ? introFaible : classeMoyenne <= 12 ? introMoyen : introExcellent;
    rapport += intros[Math.floor(Math.random() * intros.length)]();
    rapport += `Sur un effectif de ${eleves.length} élèves, ${elevesAvecNotes.length} ont participé aux évaluations. `;
    rapport += `Répartition : ${faible} en dessous de 10, ${moyen} entre 10 et 12, ${fort} au‑delà de 12.\n\n`;

    rapport += `📊 <strong>Répartition visuelle des niveaux</strong>\n`;
    const totalAN = elevesAvecNotes.length;
    rapport += `Faibles (<10)  : ${generateBar(faible, totalAN)} ${faible}/${totalAN}\n`;
    rapport += `Moyens (10-12) : ${generateBar(moyen,  totalAN)} ${moyen}/${totalAN}\n`;
    rapport += `Forts (>12)    : ${generateBar(fort,   totalAN)} ${fort}/${totalAN}\n\n`;

    if (top3.length > 0) {
      rapport += `Les meilleurs élèves : `;
      rapport += top3.map(e => `${e.prenom} ${e.nom} (${e.moyenne.toFixed(2)})`).join(', ') + '. ';
    }
    if (bottom3.length > 0) {
      rapport += `Élèves nécessitant un soutien : `;
      rapport += bottom3.map(e => `${e.prenom} ${e.nom} (${e.moyenne.toFixed(2)})`).join(', ') + '. ';
      if (bottom3.some(e => e.moyenne < 8)) rapport += `Plusieurs sont très en difficulté et nécessitent une prise en charge rapide. `;
    }
    rapport += `\n\n`;

    if (matiereStats.length > 0) {
      rapport += `📚 <strong>Performances détaillées par matière</strong>\n`;
      const maxLen = Math.max(...matiereStats.map(m => m.matiere.length));
      for (const m of matiereStats) {
        rapport += `${m.matiere.padEnd(maxLen)} (${m.professeur}) : ${generateBar(parseFloat(m.moyenne))} ${m.moyenne}/20 – ${m.classement}\n`;
      }
      rapport += `\n`;
    }

    // Recommandations
    const faiblesMat = matiereStats.filter(m => m.classement === "Faible");
    const tresBien   = matiereStats.filter(m => m.classement === "Très bien");
    const recos = [];
    if (faiblesMat.length > 0) recos.push(`Mettre en place un plan de remédiation en ${faiblesMat.map(m => m.matiere).join(', ')}.`);
    if (tresBien.length > 0)   recos.push(`Valoriser les bons résultats en ${tresBien.map(m => m.matiere).join(', ')}.`);
    if (faible > totalAN * 0.3) recos.push(`La proportion élevée d'élèves en difficulté justifie une réunion pédagogique.`);

    rapport += `<strong>Recommandations :</strong> `;
    rapport += recos.length > 0 ? recos.join(' ') : `Poursuivre les efforts actuels.`;
    rapport += `\n\n`;

    rapport += `<strong>Conclusion.</strong> `;
    if (classeMoyenne < 10) rapport += `Ce rapport met en évidence une situation qui requiert une intervention rapide. Un plan de remédiation et un suivi individualisé s'imposent.`;
    else if (classeMoyenne <= 12) rapport += `Les résultats sont encourageants mais perfectibles. Un accompagnement ciblé permettra d'élever le niveau général.`;
    else rapport += `La qualité des résultats est remarquable. Maintenez cette dynamique en encourageant l'excellence.`;

    return rapport;

  } catch (error) {
    console.error("Erreur dans handleClassReport:", error);
    return "❌ Erreur lors de la génération du rapport de classe.";
  }
}

// -------------------------------------------------------------
// RAPPORT INDIVIDUEL D'UN ÉLÈVE
// -------------------------------------------------------------
async function handleStudentReport(db, searchTerm, userId) {
  try {
    const eleves = await getAllEleves(db, userId);
    const normalizedSearch = normalizeString(searchTerm);
    let foundStudent = null;

    for (const eleve of eleves) {
      const prenomNorm = normalizeString(eleve.prenom || '');
      const nomNorm    = normalizeString(eleve.nom    || '');
      const fullName1  = prenomNorm + ' ' + nomNorm;
      const fullName2  = nomNorm + ' ' + prenomNorm;

      if (
        fullName1.includes(normalizedSearch) ||
        fullName2.includes(normalizedSearch) ||
        prenomNorm.includes(normalizedSearch) ||
        nomNorm.includes(normalizedSearch)
      ) {
        foundStudent = eleve;
        break;
      }
    }

    if (!foundStudent) return `😕 Impossible de trouver l'élève "${searchTerm}".`;

    const classes = await getAllClasses(db, userId);
    const classe  = classes.find(c => c.id === foundStudent.classeId);
    const classeNom = classe ? (classe.nomClasse || classe.classeNom || "Inconnue") : "Inconnue";

    const notesQuery = query(
      collection(db, 'notes'),
      where('eleveId', '==', foundStudent.id),
      where('createdBy', '==', userId)
    );
    const notesSnap = await getDocs(notesQuery);

    if (notesSnap.empty) {
      return `📋 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong> (${classeNom})\n📭 Aucune note enregistrée pour cet élève.`;
    }

    const matiereNotes = new Map();
    let totalGeneral = 0, nbNotesGeneral = 0;

    notesSnap.forEach(doc => {
      const noteData = doc.data();
      const val = Number(noteData.note || noteData.valeur);
      if (isNaN(val)) return;
      const matiere = noteData.matiere || "Matière inconnue";
      if (!matiereNotes.has(matiere)) matiereNotes.set(matiere, []);
      matiereNotes.get(matiere).push(val);
      totalGeneral += val;
      nbNotesGeneral++;
    });

    if (nbNotesGeneral === 0) {
      return `📋 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong> (${classeNom})\n📭 Aucune note valide trouvée.`;
    }

    const moyenneGenerale = totalGeneral / nbNotesGeneral;
    const matieresStats = [];
    const fortes = [], moyennes = [], faibles = [];

    for (const [matiere, notes] of matiereNotes.entries()) {
      const moy = notes.reduce((a, b) => a + b, 0) / notes.length;
      matieresStats.push({ matiere, moyenne: moy, nbNotes: notes.length });
      if (moy >= 13) fortes.push({ matiere, moyenne: moy });
      else if (moy >= 10) moyennes.push({ matiere, moyenne: moy });
      else faibles.push({ matiere, moyenne: moy });
    }

    const profil = moyenneGenerale < 10 ? "faible" : moyenneGenerale <= 12 ? "moyen" : "bon";

    const generateBar = (value, max = 20, length = 20) => {
      const filled = Math.round((value / max) * length);
      return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, length - filled));
    };

    let rapport = `📋 <strong>Rapport pédagogique – ${foundStudent.prenom} ${foundStudent.nom}</strong>\n`;
    rapport += `Classe : <strong>${classeNom}</strong>\n\n`;

    const intros = {
      faible: [
        `${foundStudent.prenom} présente des résultats préoccupants avec une moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
        `Les performances de ${foundStudent.prenom} sont insuffisantes (${moyenneGenerale.toFixed(2)}/20). `,
      ],
      moyen: [
        `${foundStudent.prenom} obtient ${moyenneGenerale.toFixed(2)}/20, niveau correct mais perfectible. `,
        `Les résultats de ${foundStudent.prenom} sont satisfaisants (${moyenneGenerale.toFixed(2)}/20) mais des progrès sont possibles. `,
      ],
      bon: [
        `${foundStudent.prenom} se distingue avec une excellente moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
        `Félicitations à ${foundStudent.prenom} pour sa moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
      ]
    };
    const introList = intros[profil];
    rapport += introList[Math.floor(Math.random() * introList.length)];
    rapport += `Évalué(e) dans ${matieresStats.length} matière(s). `;
    rapport += `Fortes : ${fortes.length} ; moyennes : ${moyennes.length} ; faibles : ${faibles.length}.\n\n`;

    rapport += `📚 <strong>Détail par matière</strong>\n`;
    const maxLen = Math.max(...matieresStats.map(m => m.matiere.length));
    for (const m of matieresStats.sort((a, b) => b.moyenne - a.moyenne)) {
      rapport += `${m.matiere.padEnd(maxLen)} : ${generateBar(m.moyenne)} ${m.moyenne.toFixed(2)}/20 (${m.nbNotes} note(s))\n`;
    }
    rapport += `\n`;

    if (fortes.length > 0) rapport += `✅ <strong>Points forts</strong> : ${fortes.map(f => `${f.matiere} (${f.moyenne.toFixed(2)})`).join(', ')}\n`;
    if (faibles.length > 0) rapport += `⚠️ <strong>Points faibles</strong> : ${faibles.map(f => `${f.matiere} (${f.moyenne.toFixed(2)})`).join(', ')}\n`;
    rapport += `\n`;

    const recos = {
      faible: [
        "Mettre en place un soutien ciblé dans les matières sous 10.",
        "Envisager un tutorat pour les notions fondamentales.",
        "Organiser un entretien avec les parents pour un plan de remédiation.",
      ],
      moyen: [
        "Consolider les acquis par des exercices d'approfondissement.",
        "Encourager une participation orale plus active.",
        "Fixer des objectifs progressifs dans les matières faibles.",
      ],
      bon: [
        "Valoriser l'excellence en proposant des projets avancés.",
        "Préparer l'élève à des concours ou options d'excellence.",
        "Encourager l'approfondissement autonome dans les matières de prédilection.",
      ]
    };

    rapport += `🎯 <strong>Recommandations</strong> :\n`;
    recos[profil].forEach(r => rapport += `- ${r}\n`);
    rapport += `\n`;

    rapport += `📝 <strong>Conclusion</strong> : `;
    if (profil === "faible") rapport += `La situation de ${foundStudent.prenom} nécessite une intervention rapide. Un accompagnement personnalisé et un dialogue avec la famille s'imposent.`;
    else if (profil === "moyen") rapport += `${foundStudent.prenom} dispose d'une base solide. Avec un peu plus d'investissement, le cap des 12 peut être dépassé.`;
    else rapport += `Félicitations à ${foundStudent.prenom} pour ces très bons résultats. Il/elle est invité(e) à maintenir cette dynamique.`;

    return rapport;

  } catch (error) {
    console.error("Erreur dans handleStudentReport:", error);
    return "❌ Erreur lors de la génération du rapport individuel.";
  }
}
