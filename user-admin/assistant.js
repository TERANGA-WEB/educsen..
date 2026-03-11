// assistant.js – Module de recherche de performances (classe, professeur ou élève)
import {
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

// -------------------------------------------------------------
// CONSTANTES ET CACHE (indexé par userId)
// -------------------------------------------------------------
const DATA_CACHE_TTL = 15 * 60 * 1000;
const cacheByUser = new Map();

function getUserCache(userId) {
  if (!cacheByUser.has(userId)) {
    cacheByUser.set(userId, {
      classes: null, classesCacheTime: 0,
      evals:   null, evalsCacheTime:   0,
      eleves:  null, elevesCacheTime:  0,
    });
  }
  return cacheByUser.get(userId);
}

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

function normalizeUserMessage(msg) {
  let normalized = msg
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const synonymMap = {
    'élève': 'eleve', 'étudiant': 'eleve', 'etudiant': 'eleve',
    'notes': 'eleve', 'note': 'eleve', 'bulletin': 'eleve',
    'prof': 'professeur',
  };
  for (const [word, replacement] of Object.entries(synonymMap)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'gi'), replacement);
  }

  const useless = [
    'quels sont', 'quel est', 'montre moi', 'montre-moi', 'affiche',
    'je veux', 'je voudrais', 'veuillez', 'merci', 's il te plait',
    's il vous plait', 'stp', 'svp', 'donne moi', 'donne-moi',
    'les', 'la', 'le', 'des', 'de', 'du', 'resultats', 'résultats',
  ];
  useless.forEach(phrase => {
    normalized = normalized.replace(new RegExp(`\\b${phrase}\\b`, 'gi'), ' ');
  });

  normalized = normalized.replace(/\s+/g, ' ').trim();

  const targetKeywords = ['eleve', 'classe', 'professeur'];
  let bestIndex = -1, bestKeyword = null;
  for (const kw of targetKeywords) {
    const idx = normalized.indexOf(kw);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx; bestKeyword = kw;
    }
  }
  if (bestKeyword !== null) normalized = normalized.substring(bestIndex);

  return normalized.replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------------
// FONCTION PRINCIPALE — userId obligatoire
// -------------------------------------------------------------
export default async function assistant(message, userId, db) {
  const rawMessage = message.trim();

  if (!userId) return "❌ Utilisateur non identifié. Veuillez vous reconnecter.";
  if (!db)     return "❌ Base de données non disponible. Veuillez recharger la page.";

  const normalizedMessage = normalizeUserMessage(rawMessage);

  // ---- Aide ----
  if (normalizedMessage === '/aide' || normalizedMessage === 'aide') {
    return `Commandes disponibles :

// Élève commande
- <strong>donne moi les notes de</strong> [nom] : Voir les notes et la moyenne d'un élève.
- <strong>c'est quoi les notes de</strong> [nom] : Voir les notes et la moyenne d'un élève.
- <strong>je veux les résultats de</strong> [nom] : Voir les notes et la moyenne d'un élève.
- <strong>eleve</strong> [nom] : Voir les notes et la moyenne d'un élève.

// Professeur commande
- <strong>professeur</strong> [nom] : Stats d'un prof par son nom (ex: professeur Amadou Diop).
- <strong>donne moi le bilan du professeur</strong> [nom] : Voir les notes et la moyenne d'un professeur.
- <strong>c'est quoi le bilan du professeur</strong> [nom] : Voir les notes et la moyenne d'un professeur.
- <strong>je veux le bilan du professeur</strong> [nom] : Voir les notes et la moyenne d'un professeur.
- <strong>affiche les performances du professeur</strong> [nom] : Voir les notes et la moyenne d'un professeur.

// Rapport classe commande
- <strong>rapport classe</strong> [nom] : Rapport détaillé d'une classe.
- <strong>montre moi le rapport de la classe</strong> [nom] : Rapport détaillé d'une classe.
- <strong>je veux voir le bilan de la classe</strong> [nom] : Rapport détaillé d'une classe.
- <strong>affiche les résultats de la classe</strong> [nom] : Rapport détaillé d'une classe.
- <strong>donne-moi les performances de la classe</strong> [nom] : Rapport détaillé d'une classe.

// Rapport élève commande
- <strong>rapport eleve</strong> [nom] : Rapport pédagogique individuel.
- <strong>montre-moi le rapport de l'élève</strong> [nom] : Rapport pédagogique individuel.
- <strong>je veux voir le bilan de l'élève</strong> [nom] : Rapport pédagogique individuel.
- <strong>affiche les performances de l'élève</strong> [nom] : Rapport pédagogique individuel.
- <strong>donne moi le suivi scolaire de l'élève</strong> [nom] : Rapport pédagogique individuel.`;
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
        case 1: result = await handleStudentSearch(db, name, userId);   break;
        case 2: result = await handleProfessorByName(db, name, userId); break;
        case 3: result = await handleClassReport(db, name, userId);     break;
        case 4: result = await handleStudentReport(db, name, userId);   break;
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
// CACHE — filtré par userId via createdBy
// -------------------------------------------------------------
async function getAllClasses(db, userId) {
  const uc = getUserCache(userId);
  if (uc.classes && Date.now() - uc.classesCacheTime < DATA_CACHE_TTL) return uc.classes;
  const snap = await getDocs(query(collection(db, 'classes'), where('createdBy', '==', userId)));
  uc.classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.classesCacheTime = Date.now();
  return uc.classes;
}

async function getAllEvaluations(db, userId) {
  const uc = getUserCache(userId);
  if (uc.evals && Date.now() - uc.evalsCacheTime < DATA_CACHE_TTL) return uc.evals;
  const snap = await getDocs(query(collection(db, 'evaluations'), where('createdBy', '==', userId)));
  uc.evals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.evalsCacheTime = Date.now();
  return uc.evals;
}

async function getAllEleves(db, userId) {
  const uc = getUserCache(userId);
  if (uc.eleves && Date.now() - uc.elevesCacheTime < DATA_CACHE_TTL) return uc.eleves;
  const snap = await getDocs(query(collection(db, 'eleves'), where('createdBy', '==', userId)));
  uc.eleves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  uc.elevesCacheTime = Date.now();
  return uc.eleves;
}

// -------------------------------------------------------------
// ÉLÈVE — recherche par nom + notes
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
      ) { foundStudent = eleve; break; }
    }
    if (!foundStudent) return `😕 Impossible de trouver l'élève "${searchTerm}".`;

    const notesSnap = await getDocs(
      query(collection(db, 'notes'),
        where('eleveId', '==', foundStudent.id),
        where('createdBy', '==', userId)
      )
    );

    if (notesSnap.empty) {
      return `🎓 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong>\n📭 Aucune note trouvée pour cet élève.`;
    }

    let total = 0, count = 0, bulletin = [];
    notesSnap.forEach(noteDoc => {
      const d = noteDoc.data();
      const val = Number(d.note || d.valeur);
      const matiere = d.matiere || "Matière inconnue";
      if (!isNaN(val)) {
        bulletin.push(`- <strong>${matiere}</strong> : ${val}/20`);
        total += val; count++;
      }
    });

    if (count === 0) return `🎓 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong>\nAucune note valide trouvée pour cet élève.`;

    const moyenne = (total / count).toFixed(2);
    return `🎓 <strong>Bulletin de ${foundStudent.prenom} ${foundStudent.nom}</strong>\n` +
           `ID Élève : ${foundStudent.id}\n\n` +
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
      return nomBD === nomUser || nomBD.replace(/\s/g,"") === nomUser.replace(/\s/g,"") || nomBD.includes(nomUser);
    });
    if (!classe) return `😕 Classe "${classeNom}" introuvable. Vérifiez le nom.`;

    const classeId = classe.id;
    const matieres = classe.matieres || [];

    const elevesSnap = await getDocs(
      query(collection(db, 'eleves'),
        where('classeId', '==', classeId),
        where('createdBy', '==', userId)
      )
    );
    const eleves = elevesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (eleves.length === 0) return `📚 Classe <strong>${classeNom}</strong>\nAucun élève inscrit dans cette classe.`;

    const allEvals = await getAllEvaluations(db, userId);
    const evalMap = new Map();
    allEvals.forEach(e => evalMap.set(e.id, e.matiereNom || e.matiere || "Inconnue"));

    const elevesWithNotes = await Promise.all(eleves.map(async (eleve) => {
      const notesSnap = await getDocs(
        query(collection(db, 'notes'),
          where('eleveId', '==', eleve.id),
          where('createdBy', '==', userId)
        )
      );
      let notes = [], total = 0, count = 0;
      notesSnap.forEach(doc => {
        const d = doc.data();
        const val = Number(d.note || d.valeur);
        if (!isNaN(val)) {
          const matiere = evalMap.get(d.evaluationId) || d.matiere || "Inconnue";
          notes.push({ matiere, valeur: val });
          total += val; count++;
        }
      });
      return { id: eleve.id, prenom: eleve.prenom||"", nom: eleve.nom||"", notes, moyenne: count>0 ? total/count : 0, nbNotes: count };
    }));

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

    const matiereMap = new Map();
    elevesAvecNotes.forEach(eleve => {
      eleve.notes.forEach(n => {
        if (!matiereMap.has(n.matiere)) {
          const matInfo = matieres.find(m => m.nom === n.matiere || m.matiereNom === n.matiere);
          matiereMap.set(n.matiere, { total:0, count:0, professeur: matInfo?.professeurNom || "Inconnu" });
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

    let rapport = `📋 <strong>Rapport pédagogique – Classe ${classeNom}</strong>\n\n`;
    const indiceGlobal = classeMoyenne < 10 ? "⚠️ Niveau critique" : classeMoyenne <= 12 ? "📈 Niveau intermédiaire" : "🏆 Niveau d'excellence";
    rapport += `<strong>${indiceGlobal}</strong> – `;

    const introFaible = [
      () => `La classe ${classeNom} présente des résultats préoccupants, avec une moyenne générale de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Les performances globales de la classe sont alarmantes : seuls ${fort} élèves dépassent la moyenne sur ${elevesAvecNotes.length} évalués. `,
      () => `L'analyse révèle une situation critique : la moyenne de classe s'établit à ${classeMoyenne.toFixed(2)}/20, bien en deçà des attentes. `
    ];
    const introMoyen = [
      () => `La classe ${classeNom} obtient une moyenne générale de ${classeMoyenne.toFixed(2)}/20, ce qui traduit un niveau correct mais perfectible. `,
      () => `Les résultats sont globalement satisfaisants, avec une moyenne de ${classeMoyenne.toFixed(2)}/20, mais des efforts restent à fournir. `,
      () => `Avec ${fort} élèves au-dessus de 12 et ${faible} en difficulté, la classe affiche une moyenne de ${classeMoyenne.toFixed(2)}/20, signalant une marge de progression. `
    ];
    const introExcellent = [
      () => `La classe ${classeNom} se distingue par d'excellents résultats, avec une moyenne générale de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Les performances sont remarquables : ${fort} élèves dépassent les 12/20, pour une moyenne de classe de ${classeMoyenne.toFixed(2)}/20. `,
      () => `Félicitations à l'ensemble des élèves et des enseignants : la moyenne de ${classeMoyenne.toFixed(2)}/20 reflète un travail de qualité. `
    ];

    let introArr = classeMoyenne < 10 ? introFaible : classeMoyenne <= 12 ? introMoyen : introExcellent;
    rapport += introArr[Math.floor(Math.random() * introArr.length)]();
    rapport += `Sur un effectif de ${eleves.length} élèves, ${elevesAvecNotes.length} ont participé aux évaluations. `;
    rapport += `La répartition des niveaux est la suivante : ${faible} élèves en dessous de 10, ${moyen} entre 10 et 12, et ${fort} au‑delà de 12.\n\n`;

    const totalAN = elevesAvecNotes.length;
    rapport += `📊 <strong>Répartition visuelle des niveaux</strong>\n`;
    rapport += `Faibles (<10)  : ${generateBar(faible, totalAN)} ${faible}/${totalAN}\n`;
    rapport += `Moyens (10-12) : ${generateBar(moyen,  totalAN)} ${moyen}/${totalAN}\n`;
    rapport += `Forts (>12)    : ${generateBar(fort,   totalAN)} ${fort}/${totalAN}\n\n`;

    const topPhrases    = [() => `Les trois meilleurs éléments sont `, () => `En tête de classement, on retrouve `, () => `Les élèves les plus performants sont `];
    const bottomPhrases = [() => `À l'opposé, les élèves nécessitant un soutien prioritaire sont `, () => `En queue de peloton, on note `, () => `Les résultats les plus fragiles concernent `];

    if (top3.length > 0) {
      rapport += topPhrases[Math.floor(Math.random() * topPhrases.length)]();
      const topList = top3.map(e => `${e.prenom} ${e.nom} (${e.moyenne.toFixed(2)})`).join(', ');
      if (top3.length === 1) rapport += topList + '. ';
      else if (top3.length === 2) rapport += topList.replace(', ', ' et ') + '. ';
      else rapport += topList.slice(0, topList.lastIndexOf(', ')) + ` et ${top3[2].prenom} ${top3[2].nom} (${top3[2].moyenne.toFixed(2)}). `;
      if (top3.length >= 2 && top3[0].moyenne - top3[1].moyenne > 3) rapport += `Un écart significatif sépare le premier de ses poursuivants. `;
    }

    if (bottom3.length > 0) {
      rapport += bottomPhrases[Math.floor(Math.random() * bottomPhrases.length)]();
      const bottomList = bottom3.map(e => `${e.prenom} ${e.nom} (${e.moyenne.toFixed(2)})`).join(', ');
      if (bottom3.length === 1) rapport += bottomList + '. ';
      else if (bottom3.length === 2) rapport += bottomList.replace(', ', ' et ') + '. ';
      else rapport += bottomList.slice(0, bottomList.lastIndexOf(', ')) + ` et ${bottom3[2].prenom} ${bottom3[2].nom} (${bottom3[2].moyenne.toFixed(2)}). `;
      if (bottom3.some(e => e.moyenne < 8)) rapport += `Plusieurs de ces élèves sont très en difficulté et nécessitent une prise en charge rapide. `;
    }
    rapport += `\n\n`;

    if (matiereStats.length > 0) {
      rapport += `📚 <strong>Performances détaillées par matière</strong>\n`;
      const maxMatiereLength = Math.max(...matiereStats.map(m => m.matiere.length));
      const maxProfLength    = Math.max(...matiereStats.map(m => m.professeur.length));
      for (const m of matiereStats) {
        const bar           = generateBar(parseFloat(m.moyenne), 20, 20);
        const matierePadded = m.matiere.padEnd(maxMatiereLength, ' ');
        const profPadded    = m.professeur.padEnd(maxProfLength, ' ');
        rapport += `${matierePadded} (${profPadded}) : ${bar} ${m.moyenne}/20 – ${m.classement}\n`;
      }
      rapport += `\n`;
      rapport += `L'examen détaillé par discipline fait ressortir les éléments suivants : `;
      for (const m of matiereStats) {
        const appreciation = m.classement === "Faible" ? "nettement insuffisante" : m.classement === "Suffisant" ? "juste acceptable" : "tout à fait satisfaisante";
        rapport += `En ${m.matiere} (${m.professeur}), la moyenne de ${m.moyenne}/20 est ${appreciation}. `;
        if (m.classement === "Faible") rapport += `Ce résultat appelle une réflexion pédagogique et un soutien ciblé. `;
        else if (m.classement === "Très bien") rapport += `Félicitations au professeur pour cette performance. `;
      }
    } else {
      rapport += `Aucune donnée par matière n'est disponible. `;
    }
    rapport += `\n\n`;

    const tresBien   = matiereStats.filter(m => m.classement === "Très bien");
    const faiblesMat = matiereStats.filter(m => m.classement === "Faible");
    const recos = [];
    if (faiblesMat.length > 0) {
      const matNoms = faiblesMat.map(m => m.matiere).join(', ');
      recos.push(faiblesMat.length === 1
        ? `Il est impératif de mettre en place un plan de remédiation en ${matNoms} (groupes de besoin, tutorat).`
        : `Une coordination entre les enseignants de ${matNoms} est nécessaire pour élaborer un plan de rattrapage collectif.`
      );
    }
    if (tresBien.length > 0) {
      const profs = tresBien.map(m => m.professeur).join(', ');
      recos.push(`Les excellents résultats en ${tresBien.map(m => m.matiere).join(', ')} doivent être valorisés ; nous encourageons les professeurs concernés (${profs}) à partager leurs bonnes pratiques.`);
    }
    if (faible > elevesAvecNotes.length * 0.3) {
      recos.push(`La proportion élevée d'élèves en difficulté (plus de 30%) justifie la tenue d'une réunion pédagogique pour définir des actions concertées.`);
    } else if (fort > elevesAvecNotes.length * 0.4) {
      recos.push(`La dynamique positive de la classe pourrait être exploitée pour développer des projets interdisciplinaires ou des défis stimulants.`);
    } else {
      recos.push(`La répartition équilibrée des niveaux est un atout ; il convient de maintenir cette harmonie en différenciant les activités selon les besoins.`);
    }

    rapport += `<strong>Recommandations :</strong> `;
    rapport += recos.length > 0 ? recos.join(' ') + ` ` : `Poursuivre les efforts actuels et encourager les initiatives pédagogiques. `;
    rapport += `\n\n`;

    rapport += `<strong>Conclusion.</strong> `;
    if (classeMoyenne < 10) rapport += `Ce rapport met en évidence une situation qui requiert une intervention rapide et structurée de l'équipe éducative. Une stratégie de remédiation, associée à un suivi individualisé, permettra d'enrayer les difficultés et de replacer les élèves sur une trajectoire de progrès. `;
    else if (classeMoyenne <= 12) rapport += `Les résultats de la classe sont encourageants mais perfectibles. Un accompagnement ciblé des élèves moyens et fragiles, combiné à une valorisation des réussites, devrait permettre d'élever le niveau général. `;
    else rapport += `La qualité des résultats obtenus par cette classe est remarquable. Il convient de maintenir cette dynamique en encourageant l'excellence et en veillant à ce qu'aucun élève ne décroche. `;
    rapport += `Un suivi régulier des indicateurs permettra d'ajuster les actions pédagogiques tout au long de l'année.`;

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
      ) { foundStudent = eleve; break; }
    }
    if (!foundStudent) return `😕 Impossible de trouver l'élève "${searchTerm}".`;

    const classes   = await getAllClasses(db, userId);
    const classe    = classes.find(c => c.id === foundStudent.classeId);
    const classeNom = classe ? (classe.nomClasse || classe.classeNom || "Inconnue") : "Inconnue";

    const notesSnap = await getDocs(
      query(collection(db, 'notes'),
        where('eleveId', '==', foundStudent.id),
        where('createdBy', '==', userId)
      )
    );
    if (notesSnap.empty) return `📋 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong> (${classeNom})\n📭 Aucune note enregistrée pour cet élève.`;

    const matiereNotes = new Map();
    let totalGeneral = 0, nbNotesGeneral = 0;

    notesSnap.forEach(doc => {
      const d = doc.data();
      const val = Number(d.note || d.valeur);
      if (isNaN(val)) return;
      const matiere = d.matiere || "Matière inconnue";
      if (!matiereNotes.has(matiere)) matiereNotes.set(matiere, []);
      matiereNotes.get(matiere).push(val);
      totalGeneral += val; nbNotesGeneral++;
    });

    if (nbNotesGeneral === 0) return `📋 <strong>${foundStudent.prenom} ${foundStudent.nom}</strong> (${classeNom})\n📭 Aucune note valide trouvée.`;

    const moyenneGenerale = totalGeneral / nbNotesGeneral;
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

    let rapport = `📋 <strong>Rapport pédagogique – Élève ${foundStudent.prenom} ${foundStudent.nom}</strong>\n`;
    rapport += `Classe : <strong>${classeNom}</strong>\n\n`;

    const introFaible = [
      () => `${foundStudent.prenom} présente des résultats préoccupants avec une moyenne générale de ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Les performances de ${foundStudent.prenom} sont insuffisantes : moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Avec une moyenne de ${moyenneGenerale.toFixed(2)}/20, ${foundStudent.prenom} se situe en dessous du seuil de réussite. `
    ];
    const introMoyen = [
      () => `${foundStudent.prenom} obtient une moyenne générale de ${moyenneGenerale.toFixed(2)}/20, ce qui traduit un niveau correct mais perfectible. `,
      () => `Les résultats de ${foundStudent.prenom} sont globalement satisfaisants (${moyenneGenerale.toFixed(2)}/20), mais des progrès sont encore possibles. `,
      () => `Avec ${fortes.length} matière(s) forte(s) et ${faibles.length} faible(s), ${foundStudent.prenom} affiche une moyenne de ${moyenneGenerale.toFixed(2)}/20. `
    ];
    const introBon = [
      () => `${foundStudent.prenom} se distingue par d'excellents résultats, avec une moyenne générale de ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Les performances de ${foundStudent.prenom} sont remarquables : moyenne de ${moyenneGenerale.toFixed(2)}/20. `,
      () => `Félicitations à ${foundStudent.prenom} pour sa moyenne de ${moyenneGenerale.toFixed(2)}/20, reflet d'un travail de qualité. `
    ];

    let introArr = profil === "faible" ? introFaible : profil === "moyen" ? introMoyen : introBon;
    rapport += introArr[Math.floor(Math.random() * introArr.length)]();
    rapport += `L'élève a été évalué(e) dans ${matieresStats.length} matière(s). `;
    rapport += `Matières fortes (≥13) : ${fortes.length} ; moyennes (10-12) : ${moyennes.length} ; faibles (<10) : ${faibles.length}.\n\n`;

    rapport += `📚 <strong>Détail par matière</strong>\n`;
    const maxMatiereLength = Math.max(...matieresStats.map(m => m.matiere.length));
    for (const m of matieresStats.sort((a,b) => b.moyenne - a.moyenne)) {
      const bar           = generateBar(m.moyenne, 20, 20);
      const matierePadded = m.matiere.padEnd(maxMatiereLength, ' ');
      rapport += `${matierePadded} : ${bar} ${m.moyenne.toFixed(2)}/20 (${m.nbNotes} note(s))\n`;
    }
    rapport += `\n`;

    if (fortes.length > 0)  rapport += `✅ <strong>Points forts</strong> : ${fortes.map(f => `${f.matiere} (${f.moyenne.toFixed(2)})`).join(', ')}\n`;
    if (faibles.length > 0) rapport += `⚠️ <strong>Points faibles</strong> : ${faibles.map(f => `${f.matiere} (${f.moyenne.toFixed(2)})`).join(', ')}\n`;
    rapport += `\n`;

    const recoFaible = [
      "Mettre en place un soutien ciblé dans les matières où la moyenne est inférieure à 10.",
      "Envisager un tutorat par un pair ou un enseignant pour les notions fondamentales.",
      "Organiser un entretien avec les parents pour définir un plan de remédiation.",
      "Proposer des exercices supplémentaires et un suivi renforcé."
    ];
    const recoMoyen = [
      "Consolider les acquis dans les matières moyennes (10-12) par des exercices d'approfondissement.",
      "Encourager une participation orale plus active pour gagner en confiance.",
      "Travailler la méthodologie pour transformer les 12 en 14.",
      "Fixer des objectifs progressifs dans les matières faibles."
    ];
    const recoBon = [
      "Valoriser l'excellence en proposant des projets avancés ou des défis académiques.",
      "Préparer l'élève à des concours ou à des options d'excellence.",
      "Mettre en place un mentorat pour partager ses méthodes de travail.",
      "Encourager l'approfondissement autonome dans les matières de prédilection."
    ];

    let recommandations = profil === "faible" ? [...recoFaible] : profil === "moyen" ? [...recoMoyen] : [...recoBon];
    recommandations.sort(() => Math.random() - 0.5);
    rapport += `🎯 <strong>Recommandations</strong> :\n`;
    recommandations.slice(0, 3).forEach(r => rapport += `- ${r}\n`);
    rapport += `\n`;

    rapport += `📝 <strong>Conclusion</strong> : `;
    if (profil === "faible") rapport += `La situation de ${foundStudent.prenom} nécessite une intervention rapide et structurée. Un accompagnement personnalisé, associé à un dialogue avec la famille, devrait permettre de redresser la barre.`;
    else if (profil === "moyen") rapport += `${foundStudent.prenom} dispose d'une base solide mais perfectible. Avec un peu plus d'investissement et une méthode de travail adaptée, le cap des 12 peut être dépassé.`;
    else rapport += `Félicitations à ${foundStudent.prenom} pour ces très bons résultats. Il/elle est invité(e) à maintenir cette dynamique et à viser l'excellence dans les matières qui lui plaisent.`;

    return rapport;

  } catch (error) {
    console.error("Erreur dans handleStudentReport:", error);
    return "❌ Erreur lors de la génération du rapport individuel.";
  }
}


