// ============================================
// MODULE DE GESTION DES LIMITES D'ABONNEMENT (professeurs comptés depuis les classes)
// ============================================

import { getAuth } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  collection, 
  getDocs, 
  setDoc, 
  increment,
  serverTimestamp 
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

/**
 * Initialise le vérificateur de limites avec l'application Firebase.
 * @param {FirebaseApp} app - Instance Firebase initialisée.
 * @returns {Object} - Méthodes checkPlanLimit et incrementActionCount
 */
export function initSubscriptionChecker(app) {
  const auth = getAuth(app);
  const db = getFirestore(app);

  const PLAN_LIMITS = {
    Essentiel: {
      maxClasses: 5,
      maxTeachers: 15,
      dailyAssistant: 10,
      dailyExport: 10,
    },
    Standard: {
      maxClasses: 15,
      maxTeachers: 45,
      dailyAssistant: 100,
      dailyExport: 100,
    },
    Premium: {
      maxClasses: Infinity,
      maxTeachers: Infinity,
      dailyAssistant: Infinity,
      dailyExport: Infinity,
    }
  };

  async function getUserPlan() {
    const user = auth.currentUser;
    if (!user) throw new Error('Utilisateur non connecté.');

    const subRef = doc(db, 'users', user.uid, 'subscription', 'current');
    const subSnap = await getDoc(subRef);
    if (!subSnap.exists()) throw new Error('Aucun abonnement actif.');

    const sub = subSnap.data();
    const now = new Date();
    const endDate = sub.endDate?.toDate();

    if (sub.status !== 'active' || (endDate && endDate < now)) {
      throw new Error('Votre abonnement a expiré. Veuillez en activer un nouveau.');
    }

    return sub.plan;
  }

  async function countTeachersFromClasses(userUid) {
    const classesRef = collection(db, 'users', userUid, 'classes');
    const snapshot = await getDocs(classesRef);
    const teacherIds = new Set();
    
    snapshot.forEach(classeDoc => {
      const matieres = classeDoc.data().matieres || [];
      matieres.forEach(m => {
        if (m.professeurId) teacherIds.add(m.professeurId);
      });
    });

    return teacherIds.size;
  }

  async function checkPlanLimit(actionType) {
    const plan = await getUserPlan();
    const limits = PLAN_LIMITS[plan];
    if (!limits) throw new Error('Plan inconnu.');

    const user = auth.currentUser;
    if (!user) throw new Error('Utilisateur non connecté.');

    if (actionType === 'addClass') {
      const classesRef = collection(db, 'users', user.uid, 'classes');
      const snapshot = await getDocs(classesRef);
      if (snapshot.size >= limits.maxClasses) {
        throw new Error(`Votre plan ${plan} permet seulement ${limits.maxClasses} classe${limits.maxClasses > 1 ? 's' : ''}.`);
      }
    } 
    else if (actionType === 'addTeacher') {
      const totalTeachers = await countTeachersFromClasses(user.uid);
      if (totalTeachers >= limits.maxTeachers) {
        throw new Error(`Votre plan ${plan} permet seulement ${limits.maxTeachers} professeur${limits.maxTeachers > 1 ? 's' : ''}.`);
      }
    } 
    else if (actionType === 'assistantQuery' || actionType === 'exportPDF') {
      const today = new Date().toISOString().split('T')[0];
      const dailyRef = doc(db, 'users', user.uid, 'dailyCounts', today);
      const dailySnap = await getDoc(dailyRef);
      let count = 0;
      if (dailySnap.exists()) count = dailySnap.data()[actionType] || 0;

      const limit = actionType === 'assistantQuery' ? limits.dailyAssistant : limits.dailyExport;
      if (count >= limit) {
        const actionName = actionType === 'assistantQuery' ? 'requêtes assistant' : 'exports PDF';
        throw new Error(`Votre plan ${plan} permet seulement ${limit} ${actionName} par jour.`);
      }
    } 
    else {
      throw new Error(`Type d'action inconnu : ${actionType}`);
    }

    return true;
  }

  async function incrementActionCount(actionType) {
    const user = auth.currentUser;
    if (!user) throw new Error('Utilisateur non connecté.');

    const today = new Date().toISOString().split('T')[0];
    const dailyRef = doc(db, 'users', user.uid, 'dailyCounts', today);
    await setDoc(dailyRef, {
      [actionType]: increment(1),
      lastUpdated: serverTimestamp()
    }, { merge: true });
  }

  async function checkAndAlert(actionType) {
    try {
      await checkPlanLimit(actionType);
      return true;
    } catch (error) {
      alert(error.message);
      return false;
    }
  }

  return {
    checkPlanLimit,
    incrementActionCount,
    checkAndAlert
  };
}