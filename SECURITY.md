# Bezpieczeństwo

Nie umieszczaj tokenów, plików OAuth ani prywatnych raportów w issues, PR,
commitach lub publicznych załącznikach Actions. W zgłoszeniu opisz objaw i wersję,
bez sekretów i danych osobowych. Podatność zgłoś przez zakładkę Security,
jeśli prywatne zgłaszanie jest dostępne.

Opcjonalny workflow prywatnego Drive uruchamia się ręcznie wyłącznie z `main`. Dostęp do
Google Drive pochodzi z sekretu środowiska `updater`. Zalecane ustawienia:
dozwolona gałąź `main`, wymagany recenzent będący właścicielem repo oraz zakaz
omijania ochrony środowiska. Nie zatwierdzaj uruchomienia nieprzejrzanego kodu.
Workflow testów nie otrzymuje sekretów Drive i nie wykonuje publikacji danych.

Utwórz osobnego klienta OAuth dla tej instalacji, z jedynym zakresem
`https://www.googleapis.com/auth/drive.file`. Własny klient ogranicza dostęp
aplikacji do plików utworzonych lub udostępnionych temu klientowi. Ponowne użycie
klienta z innej instalacji rozszerza zasięg skutków ewentualnego wycieku tokenu.
Program odrzuca tokeny z dodatkowymi zakresami. Nie ustawia publicznego
udostępniania plików na Drive.

Kod używa osobnego znacznika własności danych. Nie importuje ani nie przejmuje
folderów innej instalacji. Folderami zarządza program; nie wskazuj cudzych
folderów jako magazynu i nie edytuj ręcznie `active.json`.

Logi działania, treści źródeł i konfiguracja prywatna nie są wysyłane do
GitHub Artifacts. Diagnostyka uruchomień Actions trafia na prywatny Drive.
Publiczne pozostają nazwa repo, kod, informacje o uruchomieniach, parametry
workflow i czasy kroków. Nazwy namespace i daty wejściowe nie powinny zawierać
danych osobowych. Sekrety nie chronią przed złośliwym kodem, któremu przyznasz dostęp.

XML/XSD jest walidowany offline z blokadą zewnętrznych zasobów i DTD.
Obowiązują limity rozmiaru odpowiedzi, kolejek, ZIP i czasu. Brak opcjonalnej
reprezentacji lub węższe metadane pozostają jawnym ostrzeżeniem w raporcie.

## Wspólna publiczna baza

Workflow `public-corpus.yml` publikuje wyłącznie materiały urzędowe z publicznej
konfiguracji. Nie otrzymuje OAuth ani innych prywatnych sekretów. Jego krótko żyjący
`GITHUB_TOKEN` jest przekazywany tylko publikatorowi, obsłudze blokady i odpowiedzi na zgłoszenie.
Procesy pobierające/parsujące źródła nie dostają tokenu publikacji.

Żądanie przez issue wybiera wyłącznie odświeżenie. Kod, konfiguracja, daty i ścieżki
nie pochodzą z treści zgłoszenia. Workflow wykonuje kod wskazany niezmiennym SHA zdarzenia
z `main`, z atomową blokadą jednego aktualizatora i godzinną ochroną przed powtórzeniami.
Nie ma kolejki: prośby podczas pracy są odrzucane. Rekord okna ostatniej operacji
chroni też przed opóźnionym wykonaniem żądania po przydzieleniu runnera.
Każde prawidłowe odświeżenie publikuje kompletny snapshot, z kontrolą poprzedniej rewizji.
Błąd nie powoduje celowego usunięcia ostatniego prawidłowego zestawu.

Włącz dodatkowo ochronę `main` zgodnie z docs/CODE_PROTECTION.md. Nie przyznawaj
nieznanym osobom praw zapisu, żeby umożliwić im odświeżanie bazy — wystarcza formularz.
