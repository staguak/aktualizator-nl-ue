# Publiczna baza prawa NL i UE

Otwarty aktualizator i wspólna baza materiałów urzędowych: **23 akty NL i 65 pozycji UE**.
Każdy może czytać i pobierać opublikowane pliki oraz kopiować kod. Zwykły odwiedzający
nie ma prawa zapisu do tego repozytorium. Poprawki można zaproponować przez pull request.

**[Otwórz aktualną bazę](https://github.com/staguak/aktualizator-nl-ue/tree/dane)** ·
**[Zamów aktualizację](https://github.com/staguak/aktualizator-nl-ue/issues/new?template=refresh-public-corpus.yml)**

Baza pojawia się po pierwszym udanym uruchomieniu workflow **Publiczna baza NL i UE**.
Daty zakresu, liczba aktów, raporty, ostrzeżenia i sumy SHA-256 są zapisane w bazie.
Nie zakładaj aktualności wyłącznie na podstawie zielonego testu kodu: sprawdź datę danych.

## Odczyt i uruchamianie

* **Każdy, również bez konta GitHub**, może otworzyć indeks i pobrać pliki bezpośrednio z gałęzi `dane`.
  Katalogi `NL/` i `UE/` zawierają Markdown, indeksy i grafiki. Zachowane wersje wcześniejszych migawek
  są dostępne przez `history.json`, który wiąże pierwotne nazwy i sumy SHA-256 z obecnymi ścieżkami.
  Wydania GitHub sprzed przejścia na ten model są materiałem historycznym.
* **Każdy zalogowany użytkownik** może zamówić odświeżenie formularzem zgłoszenia
  powyżej. Zachowaj tytuł `[Aktualizacja bazy]`. Nie wpisuj sekretów ani danych osobowych.
  Gdy aktualizator jest wolny, bot poda wynik i linki. Gdy już pracuje, prośba
  zostanie odrzucona z komunikatem i linkiem do trwającej operacji; nie trafi do kolejki.
* **Właściciel** może wybrać Actions → **Publiczna baza NL i UE** → Run workflow → `main`.
  Opcja `force` uruchamia pełny zestaw kroków pomimo skądinąd wystarczającego wyniku wstępnego.
  Opcja `full_source_audit` wymusza ponowne pobranie treści i pomija cache parserów.
  Blokada działa tak samo dla audytu pełnego i sprawdzenia przyrostowego.

Publiczne żądanie uruchamia zatwierdzony zakres z `main`. Aktualizator sprawdza
źródła oraz porównuje ustalenia prawne z poprzednią bazą. Wynik `NO_CHANGE`
pozostawia ten sam commit `dane` i udostępnia w Actions artefakt `wait.md`.

Jednocześnie działa najwyżej jeden aktualizator. **Nie ma kolejki aktualizacji.**
Nowe żądanie podczas pracy dostaje błąd „aktualizacja w toku” i nie uruchomi się później.
Dotyczy to właściciela i publicznych zgłoszeń. GitHub może przydzielić runner z opóźnieniem;
rekord ostatniej operacji pozwala odrzucić także tak opóźnione żądanie, zamiast wykonać je
po zakończeniu poprzedniej pracy. Po zakończeniu można wysłać nowe żądanie.
Wszyscy korzystają z tej samej opublikowanej bazy. **Harmonogram nie jest ustawiony.**

## Zapis danych i sprzątanie

Przy pierwszym starcie faza BASE buduje stan na `rangeFrom`, a faza UPDATE
uzupełnia go do `rangeTo`. Obie fazy podlegają audytowi w tym samym uruchomieniu.
Przy poprawnej istniejącej bazie aktualizator wykonuje fazę UPDATE.

Po audycie i scaleniu historii program porównuje osobno sumę bajtów `NL/` i `UE/`.
Spadek w którymkolwiek katalogu blokuje zapis. Zaktualizowana baza ma postać osobnych
plików na `dane`. Jedna zmiana ref z kontrolą oczekiwanego SHA instaluje spójny
commit bez rodzica. Niepowodzenie próby pozostawia ostatnią zweryfikowaną bazę.

HTTP, parsery, modele, checkpointy i wyniki walidacji korzystają z ośmiu części
cache GitHub Actions. Odpowiedź 304 pozwala wykorzystać zweryfikowany obiekt.
Poszczególne źródła są identyfikowane przez SHA-256. Oryginalny ZIP Formex
może znajdować się w cache w formacie dostawcy. Dostępnością i retencją cache
oraz logów zarządza GitHub.

Domyślna kolejność języków UE to EN, FR i języki aktywnych modułów krajowych.
Publiczny zestaw NL+UE używa EN, FR, NL. Przy potwierdzonej dostępności tylko
w innych językach indeks podaje `SKIPPED_UNSUPPORTED_LANGUAGE`.
`APPLICABILITY_UNKNOWN` oznacza zachowaną treść o niepotwierdzonym zasięgu terytorialnym.

Mała gałąź `updater-state` przechowuje jeden plik `state.json` i jeden commit: aktualny
stan RUNNING/IDLE, identyfikator uruchomienia oraz okno czasu ostatniej operacji. To
rekord blokady, nie kolejka i nie archiwum danych. Każdy zapis zastępuje poprzedni stan.
Po przerwanym zadaniu nowy start sprawdza stan właściciela w API GitHub; blokadę można
odzyskać wyłącznie po potwierdzeniu zakończenia tamtej próby. Aktywna blokada nie jest
przejmowana przez timeout lub upływ czasu. Nie edytuj tego pliku ręcznie.

Usunięcie starej historii z gałęzi nie gwarantuje natychmiastowego zmniejszenia zajętości
repo na serwerze: nieosiągalne obiekty usuwa GitHub. Markdown ma pomocniczy limit techniczny 95 MB. Podział wynika z rozdziałów,
sekcji, artykułów i innych jednostek prawnych; nie z celu znakowego. Manifest
pozwala odtworzyć całą wersję i odnaleźć jednostki. Nie ma osobnego eksportu artykułów.
Zbyt dużą jednostkę można dzielić tylko przy bezpiecznej granicy jej struktury.
Surowy RDF/XML nie ma programowego limitu wielkości. Publiczne pliki podlegają limitowi GitHub dla zwykłych obiektów Git.

Maszynowy `manifest.json` wskazuje osobne indeksy poszczególnych wersji
`LEGAL_<SHA-256>.json`. Każde odwołanie podaje akt, wersję, język, rozmiar i hash.
Indeksy zawierają pełną hierarchię jednostek oraz zakresy rekonstrukcji; znajdują
się w katalogu danego modułu. Ten podział techniczny metadanych nie zmienia granic
prawnych ani treści Markdown. Starsze manifesty z osadzonymi indeksami nadal
można odczytywać.

`IMAGE_INDEX.json` wiąże każde wystąpienie grafiki z jednostką i źródłem.
Base64 pozostaje w zweryfikowanym Markdown, a obok zapisywane są oryginalne
bajty obrazu w rozpoznanym formacie; program nie konwertuje wszystkiego do JPEG.

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
python -m pip install -r scripts/xml-requirements.txt -r scripts/rdf-requirements.txt -r scripts/image-requirements.txt
LAW_XML_VALIDATION=required node --import tsx src/github-build.ts
```

Nie przekazuj temu procesowi OAuth, tokenów GitHub ani prywatnej konfiguracji.
Lokalnie wynik pozostanie w `output/` oraz `output-ue/`. Dowody audytu znajdują się
w `.public-state/`. Aby sprawdzić obie fazy lokalnie, ustaw `LAW_PUBLIC_INITIALIZE=true`. Publikowanie
na GitHub wykonuje przygotowany workflow z kontrolą kontekstu i sprzątaniem.

## Weryfikacja i koszty

Workflow **Verify public updater code** testuje zmiany bez dostępu do danych prywatnych.
Sprawdzenia obejmują parsery, oba moduły, XML, integralność, ochronę parametrów,
atomową publikację, zachowanie historii, konflikt równoległego zapisu i sprzątanie.
Dodatkowo każdy publiczny zestaw przechodzi niezależny audyt bajtów źródeł i ZIP/XML.
Brak opcjonalnego Formex lub węższe metadane RDF pozostają ostrzeżeniem w raporcie.

Standardowy runner `ubuntu-24.04` w publicznym repo jest bezpłatny według zasad GitHub.
Obowiązują limity techniczne, m.in. 6 godzin na zadanie oraz ograniczenia źródeł i repo.
Kod korzysta z oficjalnych źródeł; sprawdzenie techniczne nie stanowi porady prawnej
ani potwierdzenia poprawności interpretacji przepisów.

Kod: [MIT](LICENSE), z wyjątkami opisanymi w [NOTICE](NOTICE) i [THIRD_PARTY.md](THIRD_PARTY.md).
Uwagi i poprawki: issues i PR. Zasady bezpieczeństwa: [SECURITY.md](SECURITY.md).
