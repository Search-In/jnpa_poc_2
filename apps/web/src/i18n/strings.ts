/**
 * i18n scaffolding — Hindi / English / Marathi (prompt §1, Corrigendum 3 App A6).
 * UI chrome strings; notification bodies are already trilingual in the data model.
 */
export type Lang = 'en' | 'hi' | 'mr';

export const STRINGS: Record<string, Record<Lang, string>> = {
  appTitle: {
    en: 'DTCCC — Cargo Handling & Logistics',
    hi: 'DTCCC — कार्गो हैंडलिंग और लॉजिस्टिक्स',
    mr: 'DTCCC — कार्गो हाताळणी आणि लॉजिस्टिक्स',
  },
  panel_map: { en: 'Port Operations Map', hi: 'पोर्ट संचालन मानचित्र', mr: 'बंदर संचालन नकाशा' },
  panel_kpis: { en: 'Key Performance Indicators', hi: 'मुख्य प्रदर्शन संकेतक', mr: 'मुख्य कामगिरी निर्देशक' },
  panel_movements: { en: 'Container Movements', hi: 'कंटेनर संचलन', mr: 'कंटेनर हालचाली' },
  panel_pendency: { en: 'Container Pendency', hi: 'कंटेनर लंबितता', mr: 'कंटेनर प्रलंबितता' },
  panel_rail: { en: '360° Rail-Side (T1/T2)', hi: '360° रेल-साइड (T1/T2)', mr: '360° रेल्वे-बाजू (T1/T2)' },
  panel_gate: { en: 'Gate Operations', hi: 'गेट संचालन', mr: 'गेट संचालन' },
  panel_scan: { en: 'Customs / Scan', hi: 'सीमा शुल्क / स्कैन', mr: 'सीमाशुल्क / स्कॅन' },
  panel_empty: { en: 'Empty Container Pool', hi: 'खाली कंटेनर पूल', mr: 'रिकामा कंटेनर पूल' },
  panel_health: { en: 'Integration Health', hi: 'एकीकरण स्वास्थ्य', mr: 'एकत्रीकरण आरोग्य' },
  panel_notifications: { en: 'Notifications', hi: 'सूचनाएं', mr: 'सूचना' },
  panel_scenarios: { en: 'What-If Scenarios', hi: 'क्या-अगर परिदृश्य', mr: 'काय-तर परिस्थिती' },
  role: { en: 'Role', hi: 'भूमिका', mr: 'भूमिका' },
  language: { en: 'Language', hi: 'भाषा', mr: 'भाषा' },
  baseline: { en: 'baseline', hi: 'आधार रेखा', mr: 'आधाररेषा' },
  improvement: { en: 'improvement', hi: 'सुधार', mr: 'सुधारणा' },
  ack: { en: 'Acknowledge', hi: 'स्वीकार करें', mr: 'मान्य करा' },
  run: { en: 'Run', hi: 'चलाएं', mr: 'चालवा' },
  before: { en: 'Before', hi: 'पहले', mr: 'आधी' },
  after: { en: 'After', hi: 'बाद', mr: 'नंतर' },
};

export function t(key: string, lang: Lang): string {
  return STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
}
