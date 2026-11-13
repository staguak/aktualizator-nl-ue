# Publiczna baza prawa NL i UE

Otwarty aktualizator i wspólna baza materiałów urzędowych: **23 akty NL i 65 pozycji UE**.
Każdy może czytać i pobierać opublikowane pliki oraz kopiować kod. Zwykły odwiedzający
nie ma prawa zapisu do tego repozytorium. Poprawki można zaproponować przez pull request.

**[Otwórz aktualną bazę](https://github.com/staguak/aktualizator-nl-ue/tree/dane)** ·
**[Pobierz ZIP](https://github.com/staguak/aktualizator-nl-ue/archive/refs/heads/dane.zip)** ·
**[Zamów aktualizację](https://github.com/staguak/aktualizator-nl-ue/issues/new?template=refresh-public-corpus.yml)**

Baza pojawia się po pierwszym udanym uruchomieniu workflow **Publiczna baza NL i UE**.
Daty zakresu, liczba aktów, raporty, ostrzeżenia i sumy SHA-256 są zapisane w bazie.
Nie zakładaj aktualności wyłącznie na podstawie zielonego testu kodu: sprawdź datę danych.

## Odczyt i uruchamianie

* **Każdy, również bez konta GitHub**, może otworzyć gałąź `dane` lub pobrać ZIP.
  Foldery `NL/` i `UE/` zawierają teksty, indeksy, raporty i oryginalne źródła.
* **Każdy zalogowany użytkownik** może zamówić odświeżenie formularzem zgłoszenia
  powyżej. Zachowaj tytuł `[Aktualizacja bazy]`. Nie wpisuj sekretów ani danych osobowych.
  Gdy aktualizator jest wolny, bot poda wynik i linki. Gdy już pracuje, prośba
  zostanie odrzucona z komunikatem i linkiem do trwającej operacji; nie trafi do kolejki.
* **Właściciel** może wybrać Actions → **Publiczna baza NL i UE** → Run workflow → `main`.
  Opcja `force` pomija godzinną ochronę przed powtarzaniem tego samego odświeżenia.
  `full_source_audit` samo wymusza ponowne pobranie wszystkich treści i pominięcie cache
  parserów, również dla świeżej bazy i bez zaznaczania `force`. Żadna z tych opcji
  nie omija blokady aktualizatora, który już pracuje.

Publiczne żądanie wybiera wyłącznie działanie „odśwież”. Nie wybiera kodu, gałęzi,
ścieżek, poleceń ani konfiguracji. Używa zatwierdzonego zakresu z `main`.
Jeśli ten sam wykonywalny kod i konfiguracja opublikowały poprawny zestaw mniej niż godzinę
wcześniej i dla tego samego dnia w Warszawie, żądanie zwróci istniejącą bazę.
Po godzinie albo zmianie dnia, wykonywalnego kodu lub konfiguracji potrzebne jest nowe
sprawdzenie. Zmiana autora, komunikatu scalenia, dokumentacji lub testów nie wymusza
pobierania całego korpusu. Manifest zachowuje rzeczywistą rewizję producenta, a osobny
`executionSha256` identyfikuje kod używany do decyzji o ponownym budowaniu.

Jednocześnie działa najwyżej jeden aktualizator. **Nie ma kolejki aktualizacji.**
Nowe żądanie podczas pracy dostaje błąd „aktualizacja w toku” i nie uruchomi się później.
Dotyczy to właściciela i publicznych zgłoszeń. GitHub może przydzielić runner z opóźnieniem;
rekord ostatniej operacji pozwala odrzucić także tak opóźnione żądanie, zamiast wykonać je
po zakończeniu poprzedniej pracy. Po zakończeniu można wysłać nowe żądanie.
Wszyscy korzystają z tej samej opublikowanej bazy. **Harmonogram nie jest ustawiony.**

## Zapis danych i sprzątanie

Program pobiera źródła i buduje oba moduły na tymczasowym runnerze GitHub. Po kontroli
kompletności, treści, ZIP/XML i hashy publikuje **jeden spójny zestaw na gałęzi `dane`**.
Cały wskaźnik gałęzi zmienia się atomowo, z kontrolą poprzedniej rewizji. Błąd budowania
lub równoległa zmiana magazynu nie usuwa ostatniego poprawnego zestawu.

Każda publikacja danych jest nowym, niezależnym commitem bez rodzica. Zastępuje stary
snapshot, usuwa zbędne pliki poprzedniej wersji i nie zachowuje łańcucha starych wydań
tej gałęzi. Historyczne teksty przepisów potrzebne dla wybranego zakresu są nadal
częścią materiału urzędowego; nie są zbędnymi plikami technicznymi.

Końcowe kroki `always()` zapisują bezpieczne podsumowanie wyniku, zwalniają blokadę
i usuwają lokalne wyniki, checkpointy, cache źródeł, logi budowania oraz tymczasowe repozytoria. Runner jest następnie usuwany przez GitHub. Nie tworzymy
GitHub Artifacts ani trwałego cache Actions. Logi statusów i informacje o zadaniach
pozostają widoczne na GitHub zgodnie z jego zasadami przechowywania. W razie błędu
podsumowanie zawiera kod przyczyny, etap i bezpieczne wskazanie miejsca w kodzie.
Błąd powiadomienia bota jest ostrzeżeniem i nie zmienia potwierdzonego wyniku publikacji.
Powiadomienia mają ograniczone ponawianie i znacznik zapobiegający dublowaniu komentarzy.

Mała gałąź `updater-state` przechowuje jeden plik `state.json` i jeden commit: aktualny
stan RUNNING/IDLE, identyfikator uruchomienia oraz okno czasu ostatniej operacji. To
rekord blokady, nie kolejka i nie archiwum danych. Każdy zapis zastępuje poprzedni stan.
Po przerwanym zadaniu nowy start sprawdza stan właściciela w API GitHub; blokadę można
odzyskać wyłącznie po potwierdzeniu zakończenia tamtej próby. Aktywna blokada nie jest
przejmowana przez timeout lub upływ czasu. Nie edytuj tego pliku ręcznie.

Usunięcie starej historii z gałęzi nie gwarantuje natychmiastowego zmniejszenia zajętości
repo na serwerze: nieosiągalne obiekty usuwa GitHub. Program odrzuca pojedynczy plik
większy niż 95 MB lub zestaw większy niż 500 MB, zamiast opublikować niepełne dane.

## Ochrona kodu i poświadczenia

Publiczna publikacja **nie wymaga Google Drive, OAuth ani prywatnego sekretu**.
Krótko żyjący `GITHUB_TOKEN`, tworzony przez GitHub, dostaje dopiero krok publikacji
oraz kroki obsługi blokady i odpowiedzi na zgłoszenie. Proces przetwarzania źródeł go
nie otrzymuje.
Kod pozostaje na `main`; dane trafiają do `dane`, a rekord blokady do `updater-state`.

Właściciel powinien włączyć ochronę `main`: wymagany PR i poprawny test `verify`,
wyłączone force push i usuwanie gałęzi. Instrukcja: [docs/CODE_PROTECTION.md](docs/CODE_PROTECTION.md).
Ochrona kodu nie blokuje czytania, pobierania ani tworzenia własnych kopii.

Opcjonalna prywatna instalacja Drive nadal jest dostępna jako osobny workflow;
jej instrukcja znajduje się w [docs/PRIVATE_DRIVE.md](docs/PRIVATE_DRIVE.md).
Sekretów Drive nie dodawaj do workflow publicznej bazy.

## Własna kopia i konfiguracja

Utwórz publiczny fork, włącz Actions i zachowaj gałąź `main` jako domyślną.
W `aktualizator-ph/config/` ustaw zakres dla swojej wspólnej bazy. Konfiguracja oraz
wszystkie opublikowane przez ten workflow wyniki będą publiczne.
Zaktualizuj w swojej kopii linki w README, aby prowadziły do Twojego repo.
[Opis konfiguracji](docs/CONFIGURATION.md) dotyczy selektorów BWB i CELEX;
ustawienia odbiorców Drive nie są potrzebne do publikacji na GitHub.
W swojej kopii chroń `main`, a dla `dane` i `updater-state` zachowaj możliwość zapisu
z dokładnym lease przez workflow.

Lokalne zbudowanie publicznego zestawu (Linux x86_64, Node z `.node-version`, Python 3.12):

```sh
cd aktualizator-ph
npm ci
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/xml-requirements.txt -r scripts/rdf-requirements.txt
LAW_XML_VALIDATION=required node --import tsx src/github-build.ts
```

Nie przekazuj temu procesowi OAuth, tokenów GitHub ani prywatnej konfiguracji.
Lokalnie wynik pozostanie w `output/` oraz `output-ue/`. Automatyczne publikowanie
na GitHub wykonuje przygotowany workflow z kontrolą kontekstu i sprzątaniem.

## Weryfikacja i koszty

Workflow **Verify public updater code** testuje zmiany bez dostępu do danych prywatnych.
Sprawdzenia obejmują parsery, oba moduły, XML, integralność, ochronę parametrów,
atomową publikację, usuwanie starego snapshotu, konflikt równoległego zapisu i sprzątanie.
Dodatkowo każdy publiczny zestaw przechodzi niezależny audyt bajtów źródeł i ZIP/XML.
Brak opcjonalnego Formex lub węższe metadane RDF pozostają ostrzeżeniem w raporcie.

Standardowy runner `ubuntu-24.04` w publicznym repo jest bezpłatny według zasad GitHub.
Obowiązują limity techniczne, m.in. 6 godzin na zadanie oraz ograniczenia źródeł i repo.
Kod korzysta z oficjalnych źródeł; sprawdzenie techniczne nie stanowi porady prawnej
ani potwierdzenia poprawności interpretacji przepisów.

Kod: [MIT](LICENSE), z wyjątkami opisanymi w [NOTICE](NOTICE) i [THIRD_PARTY.md](THIRD_PARTY.md).
Uwagi i poprawki: issues i PR. Zasady bezpieczeństwa: [SECURITY.md](SECURITY.md).
