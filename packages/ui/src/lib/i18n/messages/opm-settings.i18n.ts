const en = {
  'opm.settings.restartLabel': 'Requires supervisor restart',
  'opm.settings.title': 'OPM settings',
  'opm.settings.admit': 'Admit new work',
  'opm.settings.admitHelp': 'Off: existing work continues, but no new issues are admitted.',
  'opm.settings.advanced': 'Advanced',
  'opm.settings.global': 'Global settings',
  'opm.settings.save': 'Validate and apply',
  'opm.settings.reload': 'Reload settings',
  'opm.settings.inherit': 'Effective {field}: {value}. Source: {source}.',
  'opm.settings.applied': 'Applied to running supervisor',
  'opm.settings.restart': 'Restart required: {fields}. Saved changes are not yet applied.',
  'opm.settings.confirm': 'Confirm sensitive changes',
  'opm.settings.syntax': 'Arrays and objects use JSON. Clear a field to remove its override.',
  'opm.settings.invalid': 'Invalid JSON in {field}',
};
type Messages = Record<keyof typeof en, string>;
const de = {
  'opm.settings.restartLabel': 'Erfordert einen Neustart des Supervisors',
  'opm.settings.title': 'OPM-Einstellungen', 'opm.settings.admit': 'Neue Arbeit zulassen', 'opm.settings.admitHelp': 'Aus: Bestehende Arbeit läuft weiter, aber neue Issues werden nicht aufgenommen.',
  'opm.settings.advanced': 'Erweitert', 'opm.settings.global': 'Globale Einstellungen', 'opm.settings.save': 'Prüfen und anwenden', 'opm.settings.reload': 'Einstellungen neu laden',
  'opm.settings.inherit': 'Wirksamer Wert für {field}: {value}. Quelle: {source}.', 'opm.settings.applied': 'Auf den laufenden Supervisor angewendet', 'opm.settings.restart': 'Neustart erforderlich: {fields}. Gespeicherte Änderungen sind noch nicht angewendet.',
  'opm.settings.confirm': 'Sensible Änderungen bestätigen', 'opm.settings.syntax': 'Arrays und Objekte verwenden JSON. Ein leeres Feld entfernt die Überschreibung.', 'opm.settings.invalid': 'Ungültiges JSON in {field}',
} satisfies Messages;
const es = {
  'opm.settings.restartLabel': 'Requiere reiniciar el supervisor',
  'opm.settings.title': 'Ajustes de OPM', 'opm.settings.admit': 'Admitir trabajo nuevo', 'opm.settings.admitHelp': 'Desactivado: el trabajo existente continúa, pero no se admiten nuevas incidencias.',
  'opm.settings.advanced': 'Avanzado', 'opm.settings.global': 'Ajustes globales', 'opm.settings.save': 'Validar y aplicar', 'opm.settings.reload': 'Recargar ajustes',
  'opm.settings.inherit': 'Valor efectivo de {field}: {value}. Origen: {source}.', 'opm.settings.applied': 'Aplicado al supervisor en ejecución', 'opm.settings.restart': 'Reinicio necesario: {fields}. Los cambios guardados aún no se han aplicado.',
  'opm.settings.confirm': 'Confirmar cambios sensibles', 'opm.settings.syntax': 'Las matrices y los objetos usan JSON. Vacía un campo para eliminar su valor personalizado.', 'opm.settings.invalid': 'JSON no válido en {field}',
} satisfies Messages;
const fr = {
  'opm.settings.restartLabel': 'Nécessite un redémarrage du superviseur',
  'opm.settings.title': 'Paramètres OPM', 'opm.settings.admit': 'Accepter de nouveaux travaux', 'opm.settings.admitHelp': 'Désactivé : les travaux existants continuent, mais aucun nouveau ticket n’est admis.',
  'opm.settings.advanced': 'Avancé', 'opm.settings.global': 'Paramètres globaux', 'opm.settings.save': 'Valider et appliquer', 'opm.settings.reload': 'Recharger les paramètres',
  'opm.settings.inherit': 'Valeur effective de {field} : {value}. Source : {source}.', 'opm.settings.applied': 'Appliqué au superviseur en cours', 'opm.settings.restart': 'Redémarrage requis : {fields}. Les modifications enregistrées ne sont pas encore appliquées.',
  'opm.settings.confirm': 'Confirmer les modifications sensibles', 'opm.settings.syntax': 'Les tableaux et objets utilisent JSON. Videz un champ pour supprimer sa valeur personnalisée.', 'opm.settings.invalid': 'JSON invalide dans {field}',
} satisfies Messages;
const ja = {
  'opm.settings.restartLabel': 'スーパーバイザーの再起動が必要です',
  'opm.settings.title': 'OPM 設定', 'opm.settings.admit': '新しい作業を受け入れる', 'opm.settings.admitHelp': 'オフ：既存の作業は続行しますが、新しい課題は受け入れません。',
  'opm.settings.advanced': '詳細設定', 'opm.settings.global': '全体設定', 'opm.settings.save': '検証して適用', 'opm.settings.reload': '設定を再読み込み',
  'opm.settings.inherit': '{field} の有効値：{value}。設定元：{source}。', 'opm.settings.applied': '実行中のスーパーバイザーに適用しました', 'opm.settings.restart': '再起動が必要：{fields}。保存した変更はまだ適用されていません。',
  'opm.settings.confirm': '重要な変更を確認', 'opm.settings.syntax': '配列とオブジェクトには JSON を使用します。フィールドを空にすると上書き設定を削除します。', 'opm.settings.invalid': '{field} の JSON が無効です',
} satisfies Messages;
const ko = {
  'opm.settings.restartLabel': '감독자 재시작 필요',
  'opm.settings.title': 'OPM 설정', 'opm.settings.admit': '새 작업 수락', 'opm.settings.admitHelp': '끔: 기존 작업은 계속되지만 새 이슈는 수락하지 않습니다.',
  'opm.settings.advanced': '고급', 'opm.settings.global': '전역 설정', 'opm.settings.save': '검증 및 적용', 'opm.settings.reload': '설정 새로고침',
  'opm.settings.inherit': '{field}의 적용 값: {value}. 출처: {source}.', 'opm.settings.applied': '실행 중인 감독자에 적용됨', 'opm.settings.restart': '재시작 필요: {fields}. 저장된 변경 사항은 아직 적용되지 않았습니다.',
  'opm.settings.confirm': '민감한 변경 확인', 'opm.settings.syntax': '배열과 객체는 JSON을 사용합니다. 필드를 비우면 재정의가 제거됩니다.', 'opm.settings.invalid': '{field}의 JSON이 잘못되었습니다',
} satisfies Messages;
const pl = {
  'opm.settings.restartLabel': 'Wymaga restartu nadzorcy',
  'opm.settings.title': 'Ustawienia OPM', 'opm.settings.admit': 'Przyjmuj nowe zadania', 'opm.settings.admitHelp': 'Wyłączone: istniejące zadania są kontynuowane, ale nowe zgłoszenia nie są przyjmowane.',
  'opm.settings.advanced': 'Zaawansowane', 'opm.settings.global': 'Ustawienia globalne', 'opm.settings.save': 'Sprawdź i zastosuj', 'opm.settings.reload': 'Wczytaj ustawienia ponownie',
  'opm.settings.inherit': 'Efektywna wartość {field}: {value}. Źródło: {source}.', 'opm.settings.applied': 'Zastosowano do działającego nadzorcy', 'opm.settings.restart': 'Wymagany restart: {fields}. Zapisane zmiany nie zostały jeszcze zastosowane.',
  'opm.settings.confirm': 'Potwierdź wrażliwe zmiany', 'opm.settings.syntax': 'Tablice i obiekty używają JSON. Wyczyść pole, aby usunąć nadpisanie.', 'opm.settings.invalid': 'Nieprawidłowy JSON w {field}',
} satisfies Messages;
const ptBR = {
  'opm.settings.restartLabel': 'Requer reinicialização do supervisor',
  'opm.settings.title': 'Configurações do OPM', 'opm.settings.admit': 'Aceitar novos trabalhos', 'opm.settings.admitHelp': 'Desativado: os trabalhos existentes continuam, mas novas issues não são aceitas.',
  'opm.settings.advanced': 'Avançado', 'opm.settings.global': 'Configurações globais', 'opm.settings.save': 'Validar e aplicar', 'opm.settings.reload': 'Recarregar configurações',
  'opm.settings.inherit': 'Valor efetivo de {field}: {value}. Origem: {source}.', 'opm.settings.applied': 'Aplicado ao supervisor em execução', 'opm.settings.restart': 'Reinicialização necessária: {fields}. As alterações salvas ainda não foram aplicadas.',
  'opm.settings.confirm': 'Confirmar alterações sensíveis', 'opm.settings.syntax': 'Matrizes e objetos usam JSON. Limpe um campo para remover sua substituição.', 'opm.settings.invalid': 'JSON inválido em {field}',
} satisfies Messages;
const uk = {
  'opm.settings.restartLabel': 'Потрібен перезапуск супервізора',
  'opm.settings.title': 'Налаштування OPM', 'opm.settings.admit': 'Приймати нові завдання', 'opm.settings.admitHelp': 'Вимкнено: наявні завдання продовжуються, але нові звернення не приймаються.',
  'opm.settings.advanced': 'Додатково', 'opm.settings.global': 'Глобальні налаштування', 'opm.settings.save': 'Перевірити й застосувати', 'opm.settings.reload': 'Перезавантажити налаштування',
  'opm.settings.inherit': 'Ефективне значення {field}: {value}. Джерело: {source}.', 'opm.settings.applied': 'Застосовано до запущеного супервізора', 'opm.settings.restart': 'Потрібен перезапуск: {fields}. Збережені зміни ще не застосовано.',
  'opm.settings.confirm': 'Підтвердити чутливі зміни', 'opm.settings.syntax': 'Масиви й об’єкти використовують JSON. Очистіть поле, щоб видалити перевизначення.', 'opm.settings.invalid': 'Некоректний JSON у {field}',
} satisfies Messages;
const zhCN = {
  'opm.settings.restartLabel': '需要重启监督程序',
  'opm.settings.title': 'OPM 设置', 'opm.settings.admit': '接受新工作', 'opm.settings.admitHelp': '关闭：现有工作继续进行，但不接受新议题。',
  'opm.settings.advanced': '高级', 'opm.settings.global': '全局设置', 'opm.settings.save': '验证并应用', 'opm.settings.reload': '重新加载设置',
  'opm.settings.inherit': '{field} 的有效值：{value}。来源：{source}。', 'opm.settings.applied': '已应用到正在运行的监督程序', 'opm.settings.restart': '需要重启：{fields}。保存的更改尚未应用。',
  'opm.settings.confirm': '确认敏感更改', 'opm.settings.syntax': '数组和对象使用 JSON。清空字段可移除覆盖值。', 'opm.settings.invalid': '{field} 中的 JSON 无效',
} satisfies Messages;
const zhTW = {
  'opm.settings.restartLabel': '需要重新啟動監督程式',
  'opm.settings.title': 'OPM 設定', 'opm.settings.admit': '接受新工作', 'opm.settings.admitHelp': '關閉：現有工作繼續進行，但不接受新議題。',
  'opm.settings.advanced': '進階', 'opm.settings.global': '全域設定', 'opm.settings.save': '驗證並套用', 'opm.settings.reload': '重新載入設定',
  'opm.settings.inherit': '{field} 的有效值：{value}。來源：{source}。', 'opm.settings.applied': '已套用至執行中的監督程式', 'opm.settings.restart': '需要重新啟動：{fields}。儲存的變更尚未套用。',
  'opm.settings.confirm': '確認敏感變更', 'opm.settings.syntax': '陣列和物件使用 JSON。清空欄位可移除覆寫值。', 'opm.settings.invalid': '{field} 中的 JSON 無效',
} satisfies Messages;
export const opmSettingsI18n = { en, de, es, fr, ja, ko, pl, 'pt-BR': ptBR, uk, 'zh-CN': zhCN, 'zh-TW': zhTW };
