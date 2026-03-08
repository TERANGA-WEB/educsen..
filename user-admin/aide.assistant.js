// semanticEngine.js
// Moteur d'analyse sémantique pour assistant scolaire
// Version améliorée :
// - Correction automatique des fautes courantes
// - Mots clés enrichis (abréviations, synonymes)
// - Détection plus robuste des cibles (élève, professeur, classe)
// - Priorisation des intentions selon le contexte
// - Score de confiance affiné
// Pas d'appel Firestore, pas de DOM, pas de logique métier

// ----------------------
// Dictionnaire de correction des fautes courantes
// ----------------------
const TYPO_CORRECTIONS = {
  // Professeur
  'profeseur': 'professeur',
  'professeur': 'professeur',
  'prof': 'professeur', // on garde 'prof' mais on le normalise en 'professeur' pour la détection
  // Classe
  'clas': 'classe',
  'clase': 'classe',
  'clace': 'classe',
  // Élève
  'eleve': 'élève',
  'élève': 'élève',
  // Notes
  'not': 'note',
  'notes': 'notes',
  // Rapport
  'raport': 'rapport',
  'rapor': 'rapport',
  // Performance
  'perf': 'performance',
  'perform': 'performance',
  // Statistiques
  'stat': 'statistique',
  'stats': 'statistique',
  'moy': 'moyenne',
  'avg': 'moyenne',
  // Bulletin
  'bulletin': 'bulletin',
  'carnet': 'carnet'
};

// ----------------------
// Mots vides (stopwords) français étendus
// ----------------------
const STOPWORDS = new Set([
  // Articles et déterminants
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd',
  // Pronoms
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'moi', 'me', 'mon', 'ma', 'mes', 'lui', 'leur',
  // Verbes courants
  'donne', 'donner', 'donnes', 'donnez', 'donnent',
  'est', 'sont', 'etre', 'etait', 'sera',
  'a', 'as', 'ai', 'ont', 'avait', 'aura',
  'peux', 'peut', 'pouvoir',
  'voir', 'vois', 'voit',
  // Mots interrogatifs / relatifs
  'quelle', 'quelles', 'quel', 'quels',
  'qui', 'que', 'quoi', 'dont', 'ou',
  // Prépositions et conjonctions
  'pour', 'avec', 'dans', 'sur', 'sous', 'en', 'par',
  'ce', 'cet', 'cette', 'ces',
  // Mots à supprimer car ils brouillent la cible (après correction)
  'classe', 'professeur', 'élève', 'eleve',
  'bonjour', 'bonsoir', 'salut', 'merci', 'svp', 'stp'
]);

// ----------------------
// Mots clés déclencheurs d'intention enrichis
// ----------------------
const INTENT_KEYWORDS = new Set([
  'rapport', 'notes', 'performance', 'statistique',
  'bulletin', 'moyenne', 'carnet', 'progression',
  // Abréviations et synonymes
  'moy', 'avg', 'perf', 'stats', 'stat'
]);

// Regroupements par famille (pour la détection d'intention)
const INTENT_GROUPS = {
  report: ['rapport', 'bulletin', 'carnet'],
  notes: ['notes', 'note', 'moyenne', 'moy', 'avg'],
  performance: ['performance', 'progression', 'perf'],
  stats: ['statistique', 'stats', 'stat']
};

// ----------------------
// Fonctions internes
// ----------------------

/**
 * Corrige les fautes d'orthographe courantes dans une chaîne.
 * Remplace les mots mal orthographiés par leur version correcte.
 * @param {string} text
 * @returns {string}
 */
function applyTypoCorrections(text) {
  let corrected = text;
  // On remplace chaque mot fautif par sa correction (en respectant les limites de mot)
  for (const [wrong, right] of Object.entries(TYPO_CORRECTIONS)) {
    // Regex pour remplacer le mot entier (boundaries) insensible à la casse
    const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
    corrected = corrected.replace(regex, right);
  }
  return corrected;
}

/**
 * Nettoie le message : minuscules, suppression accents, ponctuation, espaces superflus,
 * et applique les corrections orthographiques.
 * @param {string} msg
 * @returns {string}
 */
function normalize(msg) {
  // Étape 1 : normalisation Unicode et suppression accents
  let normalized = msg
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')           // supprime les accents
    .toLowerCase();

  // Étape 2 : correction des fautes courantes
  normalized = applyTypoCorrections(normalized);

  // Étape 3 : suppression ponctuation et espaces superflus
  normalized = normalized
    .replace(/[^\w\s]/g, ' ')                   // remplace ponctuation par espace
    .replace(/\s+/g, ' ')                       // réduit les espaces multiples
    .trim();

  return normalized;
}

/**
 * Supprime les mots vides d'un tableau de mots.
 * @param {string[]} words
 * @returns {string[]}
 */
function removeStopwords(words) {
  return words.filter(word => !STOPWORDS.has(word));
}

/**
 * Extrait les mots clés (longueur > 2) et les transforme en Set.
 * @param {string[]} words
 * @returns {Set<string>}
 */
function extractKeywordsSet(words) {
  return new Set(words.filter(w => w.length > 2));
}

/**
 * Détecte et normalise une classe à partir du message nettoyé.
 * Supporte : "5e A", "5eA", "5 e a", "5ème A", "5eme a", "5e A" etc.
 * @param {string} cleaned
 * @returns {string|null} classe normalisée (ex: "5e A") ou null
 */
function extractClass(cleaned) {
  // Regex flexible :
  // - niveau : 6e,5e,4e,3e avec possibilité de 'ème' ou 'eme' optionnel
  // - séparation par 0 ou plusieurs espaces
  // - lettre (a-z) finale
  const regex = /\b([6543])(?:e(?:me?)?)\s*([a-z])\b/i;
  const match = cleaned.match(regex);
  if (match) {
    const niveau = match[1];          // '5'
    const lettre = match[2].toUpperCase();
    return `${niveau}e ${lettre}`;    // format standard "5e A"
  }
  return null;
}

/**
 * Détecte un professeur dans le message original.
 * Accepte "prof" ou "professeur" (déjà normalisé en "professeur" par correction)
 * et capture le mot suivant (identifiant ou nom).
 * @param {string} original
 * @returns {string|null} identifiant ou nom du professeur (premier mot après)
 */
function extractProfessor(original) {
  // On utilise le message original non normalisé pour préserver les mots exacts (identifiants comme P123)
  // Mais après correction, "prof" devient "professeur", donc on cherche "professeur"
  const regex = /\bprofesseur\s+(\S+)/i;
  const match = original.match(regex);
  return match ? match[1] : null;
}

/**
 * Extrait un nom d'élève à partir des mots filtrés (après stopwords et intention).
 * Ne retourne un nom que si des mots restent.
 * @param {string[]} filteredWords
 * @param {Set<string>} keywordsSet
 * @returns {string|null}
 */
function extractStudentName(filteredWords, keywordsSet) {
  // On retire également les mots d'intention car ils ne font pas partie du nom
  const nameParts = filteredWords.filter(w => !INTENT_KEYWORDS.has(w));
  if (nameParts.length === 0) return null;
  return nameParts.join(' ');
}

/**
 * Détermine l'intention à partir du type de cible et des mots clés.
 * Utilise une priorisation contextuelle : on teste les groupes dans un ordre logique
 * et on retourne la première intention correspondante.
 * @param {string} targetType
 * @param {Set<string>} keywordsSet
 * @returns {string}
 */
function detectIntent(targetType, keywordsSet) {
  // Fonction utilitaire pour vérifier si un groupe de mots est présent
  const hasGroup = (group) => INTENT_GROUPS[group].some(w => keywordsSet.has(w));

  // Ordre de priorité : notes > rapport > performance > stats (pour les élèves/classes)
  // Mais on peut adapter selon le contexte
  if (targetType === 'classe') {
    if (hasGroup('notes')) return 'class_notes';
    if (hasGroup('report')) return 'class_report';
    if (hasGroup('performance')) return 'class_performance';
    if (hasGroup('stats')) return 'class_stats';
    return 'unknown';
  }
  if (targetType === 'professeur') {
    // Pour un professeur, l'intention est toujours "professor_stats"
    // (on pourrait affiner si besoin, mais par défaut c'est stats)
    return 'professor_stats';
  }
  if (targetType === 'eleve') {
    if (hasGroup('notes')) return 'student_notes';
    if (hasGroup('report')) return 'student_report';
    if (hasGroup('performance')) return 'student_performance';
    if (hasGroup('stats')) return 'student_stats';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Calcule un score de confiance (0-1) basé sur la qualité de la détection.
 * @param {string|null} targetType
 * @param {string} intent
 * @param {string|null} target
 * @param {Set<string>} keywordsSet
 * @returns {number}
 */
function calculateConfidence(targetType, intent, target, keywordsSet) {
  let confidence = 0.0;

  // Base selon le type de cible (plus fiable si classe, moins si élève par défaut)
  if (targetType === 'classe') confidence += 0.4;
  else if (targetType === 'professeur') confidence += 0.4;
  else if (targetType === 'eleve') confidence += 0.2;
  else return 0.0; // aucune cible → confiance nulle

  // Présence d'une intention explicite
  if (intent !== 'unknown') confidence += 0.3;

  // Présence d'une cible concrète (classe normalisée, nom élève, identifiant prof)
  if (target !== null) confidence += 0.2;

  // Bonus si plusieurs mots clés d'intention sont présents (plus de certitude)
  const intentWordCount = Array.from(keywordsSet).filter(w => INTENT_KEYWORDS.has(w)).length;
  if (intentWordCount > 1) confidence += 0.1;

  return Math.min(confidence, 1.0);
}

// ----------------------
// Fonction principale exportée
// ----------------------

/**
 * Analyse un message texte et retourne une structure sémantique enrichie.
 * @param {string} message
 * @returns {{
 *   original: string,
 *   cleaned: string,
 *   filtered: string,
 *   keywords: string[],
 *   intent: string,
 *   targetType: string|null,
 *   target: string|null,
 *   confidence: number
 * }}
 */
export function analyzeMessage(message) {
  // 1. Nettoyage (inclut correction orthographique)
  const original = message;
  const cleaned = normalize(original);

  // 2. Découpage en mots
  const words = cleaned.split(/\s+/);

  // 3. Suppression des stopwords
  const filteredWords = removeStopwords(words);
  const filtered = filteredWords.join(' ');

  // 4. Mots clés (longueur > 2)
  const keywordsSet = extractKeywordsSet(filteredWords);
  const keywords = Array.from(keywordsSet);

  // 5. Détection de la classe (prioritaire)
  const classTarget = extractClass(cleaned);
  let targetType = null;
  let target = null;

  if (classTarget) {
    targetType = 'classe';
    target = classTarget;
  } else {
    // 6. Détection du professeur
    const profTarget = extractProfessor(original); // utilise l'original pour capturer les identifiants
    if (profTarget) {
      targetType = 'professeur';
      target = profTarget;
    } else {
      // 7. Détection d'un élève (uniquement si des mots restent après retrait des stopwords et des intentions)
      const studentName = extractStudentName(filteredWords, keywordsSet);
      if (studentName) {
        targetType = 'eleve';
        target = studentName;
      }
      // sinon targetType et target restent null
    }
  }

  // 8. Détection de l'intention
  const intent = detectIntent(targetType, keywordsSet);

  // 9. Calcul de la confiance
  const confidence = calculateConfidence(targetType, intent, target, keywordsSet);

  // 10. Assemblage final
  return {
    original,
    cleaned,
    filtered,
    keywords,
    intent,
    targetType,
    target,
    confidence
  };
}