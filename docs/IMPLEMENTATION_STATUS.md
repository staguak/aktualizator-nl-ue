# Etapy 5–7 — zintegrowane lokalnie — 2026-11-14

Zaimplementowano bezstratne grafiki i IMAGE_INDEX (niezmienny Markdown/oryginały), kontrolę natywnego formatu i odczytu grafiki, dowody adres→bajty obrazów zewnętrznych, wspólne paczki źródeł NL i UE z zachowaniem dokładnych oryginałów, finalną walidację paczek oraz distribution.json. Audyt obsługuje EN/PL/NL/FR, oddzielne reprezentacje językowe i SHA oryginałów z BOM; duży RDF jest sprawdzany strumieniowo.

Workflow przygotowano do Releases i małego indeksu dane, odtwarzania runtime/checkpointów/cache, ośmiu części cache, sprzątania 7→≤4 GB oraz dwóch ostatnich prób (także błędnych) i chronionej aktywnej bazy. Nie ustawiono harmonogramu ani kolejki. Kopia kodu, ręczne uruchomienie i dotychczasowe opcje pozostają dostępne. Zakres 23 NL i 65 UE pozostaje bez zmian.

Przeglądy wykryły i doprowadziły do poprawek łącznie 10 ważnych usterek etapów 4–7; szczegóły i testy RED→GREEN w tasks/stage4-progress.md, stage5-progress.md, stage6-7-progress.md. Brak wznowienia/retencji przed pierwszą poprawną bazą i obsługa przerwanego Draft Release zostały naprawione. Niewiadomego/aktywnego właściciela draftu nie usuwa się.

Security Advisory Scout wykrył luki Pillow12.3.0; przypięto Pillow13.0.0 z hashem koła potwierdzonym w PyPI i pobranych bajtach. Zapytania OSV dla Pillow13.0.0 oraz fast-xml-parser5.12.0, fflate0.8.3 i undici7.30.1 nie zwróciły znanych podatności. Audyt workflow: 0 Critical/High/Medium; pozostał Low o braku automatycznych aktualizacji zależności, zgodnie z pozostawieniem pracy bez harmonogramu. CODEOWNERS wskazuje rzeczywistego właściciela, ale nie zastępuje reguł GitHub.

W ostatnim pełnym punkcie kontrolnym zaliczono 338 Node, 90 Python i obie kontrole typów. Po poprawkach integracji trwają końcowe kontrole. Nie utożsamiać testów lokalnych i testowego API z odbiorem całego korpusu/żywego GitHub. Etap 8 — końcowa weryfikacja i test publiczny — pozostaje do wykonania. Poniższy raport zachowuje stan historyczny wcześniejszych etapów.

# Etap 4 — ukończony lokalnie — 2026-11-14

Włączono `legal-structure-v1` dla 23 NL i 65 UE, zachowując selektory/piny i odczyt starszych konfiguracji. Markdown dzieli się według naturalnych kontenerów, oddzielnie dla każdej wersji; 95 MB jest wyłącznie zabezpieczeniem technicznym. Manifest zawiera hierarchię jednostek, identyfikatory niezależne od nazw plików, źródłowe lokalizatory, dokładne zakresy i kolejność rekonstrukcji. NL obejmuje pełne stany, w tym preambułę, załączniki i zamknięcie; UE obsługuje artykuły oraz numerowane akapity orzeczeń. Deduplikacja kanonicznych plików zachowuje własne logiczne ID wersji. Oryginały pozostają identyczne bajtowo.

Walidacja końcowa i checkpointy odtwarzają widok z oryginalnego źródła i porównują kompletny manifest/treść; przeliczenie wygenerowanych hashy nie ukrywa usunięcia lub zmiany treści. Zachowano stare kontrole artykułów i stanów NL oraz metadanych, obrazów i odsyłaczy UE. Instalacja całego zweryfikowanego zestawu usuwa nieaktualne części wyniku.

Niezależny przegląd wykrył cztery ważne błędy; wszystkie poprawiono: numeracja list, sparse CALS/rowspan, numery starszych akapitów sądowych i kontenery white-space dopasowane selektorami CSS. Nieobsługiwany układ CALS lub brak bezpiecznej granicy technicznej przerywa przetwarzanie, bez obcinania treści.

Świeża weryfikacja: 332/332 npm test, obie kontrole typów, BWB selftest, 14 testów integracji XML, 34 testy XML Python, 44 publiczne testy Python — PASS. Testy wymagające lokalnego serwera wykonano z uprawnieniem do sieci. XML wymaga przypiętego interpretera .venv; systemowy Python bez zależności był prawidłowo odrzucany. Rekonstrukcję sprawdzono też na zapisanych oficjalnych wyroku i opinii C-19/23 oraz niderlandzkiej dyrektywie 32008L0104; to nie jest odbiór całego korpusu ani publicznego przebiegu.

Dowody lokalne: `/workspace/publication-review/step4/`; plan i szczegóły doboru wtyczek/błędów: `tasks/plan.md`, `tasks/stage4-progress.md`. Etapy 5–8 nadal wymagają wykonania. Poniżej zachowano historyczny raport etapów 1–3; jego tabela opisuje stan sprzed etapu 4.

# Stan wdrożenia — kroki 1–3 — 2026-11-14

Wykonano krok 1: przegląd rozpoczętych zmian i dostosowanie sprzecznych elementów do ostatnich ustaleń. Nie ukończono całego planu. Zmiany są robocze na gałęzi `feat-incremental-public-releases-20261113`, względem `cddf701e0c2f4c0cdcb67721df63cd56cf0ca1b8`; wymagają dalszej integracji przed uruchomieniem publikacji.

Wykonano także krok 2: rozdzielenie kryteriów wyboru od zakresu pobierania. W publicznej konfiguracji zachowano dotychczasowe 23 pozycje NL, 65 pozycji UE i ich selektory/piny; włączono rozszerzone pobieranie. Krok 3 dodaje trwałe ponowne użycie źródeł, modeli i walidacji. Poniższa tabela przedstawia aktualny stan.

## Krok 2 — pełne akty i dokumenty spraw

- NL: `retrievalScope: full-act` rozszerza model na wszystkie artykuły z wybranych stanów źródłowych. Zachowuje zakres czasowy, sprawdzanie obowiązkowych artykułów i struktur oraz pierwotne selektory w manifeście. Używa pełnych odniesień artykułów, aby nie utożsamiać jednakowych numerów z różnych ksiąg. Niejednoznaczne identyfikatory blokują przetwarzanie.
- Pełne oryginały XML NL pozostają zachowane. Nowe sprawdzenie porównuje pokrycie artykuł–stan z oryginalnym XML przy odtwarzaniu checkpointu i walidacji wyniku. Usunięcie dodatkowego artykułu nie przechodzi kontroli przez samo przeliczenie hashy.
- UE: `retrievalScope: full-act-and-case` zamienia pobranie wybranej sentencji na pełny dokument, zachowując `selectionInclude: operative-part` jako przyczynę wyboru. Pozostałe kryteria wyszukiwania i daty pozostają bez zmian.
- Katalog spraw korzysta z oficjalnych relacji `work_part_of_dossier` i `dossier_contains_work` dla `case_court`. Wspólny dokument pozwala objąć formalnie połączone sprawy. Katalog nie podąża za `work_cites_work`.
- Dodano obsługę identyfikatorów CELEX opinii, postanowień, komunikatów i streszczeń. Każdy dołączony dokument ma powiązania ze sprawą i trafieniem źródłowym. Oryginalna odpowiedź katalogu pozostaje w archiwum źródeł; manifest i checkpoint są z nią porównywane.
- Dokumenty po końcu zakresu oraz bez reprezentacji w EN→PL→NL→FR są jawnie wykazywane w katalogu. Brak dozwolonego języka dokumentu pomocniczego powoduje ostrzeżenie o niepełnej historii. Brak identyfikatora dokumentu, niepełna odpowiedź katalogu lub brak formalnego powiązania trafienia blokują przetwarzanie; dostępne dane pozostają w diagnostyce. Błąd pobrania wymaganego tekstu nadal przerywa przebieg.
- Poprzednie konfiguracje bez nowego pola zachowują dotychczasowe zachowanie. Nie dodano osobnego eksportu jednostek.

### Weryfikacja kroku 2

Zaliczono 127 testów TypeScript w 16 zestawach, obie kontrole typów i test własny parsera BWB. Testy obejmują rzeczywiste wykonanie nowego zapytania SPARQL na lokalnym grafie RDF: sprawy połączone, odrębny wyrok jedynie cytowany, ponownie użyty numer sprawy w innym roku, daty, języki, niepełną odpowiedź, usunięty dokument i zmieniony katalog. Porównanie konfiguracji z HEAD potwierdziło zachowanie dotychczasowych kryteriów wszystkich 23/65 pozycji.

Odczyt rzeczywistego CELLAR wykazał 17 odrębnych dokumentów CELEX dla C‑19/23, C‑311/21, C‑426/20 i C‑649/22. Pobrano i sprawdzono tożsamość angielskiego pełnego wyroku C‑19/23 (201 330 bajtów) oraz opinii rzecznika (233 102 bajty), korzystając z pozycji XHTML potwierdzonych w WEMI. Parser zachował odpowiednio 198 779 i 225 892 znaków widoku prawnego. Bezpośredni odczyt EUR-Lex nie potwierdził tożsamości, więc nie uznano go za dowód; sprawdzenie wykonano na oficjalnych zasobach CELLAR. Nie jest to pełny przebieg wszystkich pozycji, test pobrania wszystkich 17 tekstów ani test publikacji.

Podział plików pozostaje dotychczasowy do kolejnego etapu modelowania struktury. Widok Markdown NL obejmuje obecnie wszystkie rozpoznane artykuły, natomiast pełne odwzorowanie pozostałych kontenerów aktu, w tym załączników i preambuły, wymaga następnego etapu; ich oryginalna treść pozostaje w XML.

## Krok 3 — trwała aktualizacja przyrostowa

W publicznym punkcie wejścia `github-build.ts` domyślnie włączono plikowy cache, podział cache na osiem części oraz strumieniową ścieżkę XML/RDF. Pozostawiono osobny, ręcznie wybierany pełny audyt. Nie zmieniono sposobu uruchamiania prywatnego wariantu ani nie dodano harmonogramu.

### Co program wykorzystuje ponownie

- Przed pobraniem sprawdza lokalny SHA-256, MD5 i rozmiar źródła. Poprawny wpis wysyła do urzędu żądanie warunkowe z ETag/Last-Modified. Odpowiedź 304 ponownie sprawdza plik i wykorzystuje dotychczasowe bajty. Brakujący/uszkodzony cache wymaga pobrania pełnej odpowiedzi. Przy odpowiedzi 200 porównuje SHA-256; sam jednakowy rozmiar nie potwierdza niezmienności.
- Bajty są przechowywane pod nazwami wyliczonymi z SHA-256. Nowsza odpowiedź dla tego samego URL nie nadpisuje starszego dokumentu używanego jeszcze w bieżącym przetwarzaniu. Kontrole odrzucają podmianę pliku podczas odpowiedzi 304 oraz dowiązania symboliczne.
- Oryginalne archiwa otrzymują bezpieczne wskazówki odtworzenia cache: URL, nagłówki negocjacji formatu/języka i walidatory HTTP. Dane uwierzytelniające nie trafiają do tych wskazówek. Po utracie cache program może odtworzyć źródła z archiwów poprzedniej bazy/checkpointów, a następnie sprawdzić ich aktualność w urzędzie.
- Cache parsera jest uzupełniony cache modeli NL oraz przygotowania treści/nawigacji UE. Model NL może zostać ponownie użyty po zmianie dnia końcowego, gdy zakres początkowy i dokładny zestaw przecinających zakres stanów źródłowych pozostają identyczne. Zmiana źródła, stanu, konfiguracji lub kodu unieważnia odpowiedni wynik. Nowy dzień nadal trafia do aktualnego manifestu i nagłówków.
- Wyniki udanej walidacji XML/RDF są zachowywane z powiązaniem do SHA-256 źródła, URL, rodzaju, identyfikatora dokumentu oraz wersji kodu walidatora i przypiętych schematów. Niepoprawny/brakujący wpis wymaga rzeczywistej walidacji. Błędy nie są zapisywane jako udany wynik.
- Ręczny pełny audyt pobiera treści ponownie i omija trwały cache parsera, modeli i walidacji. Nowe publiczne uruchomienie ma osobną tożsamość techniczną: checkpoint poprzedniej próby nie stanowi sam w sobie dowodu aktualności źródeł i nie pomija nowego przeglądu katalogów.

### Trwały stan i zachowanie poprawnej bazy

Pakiet runtime zachowuje checkpointy oraz cache parsera, modeli i walidacji. Surowe pliki HTTP nie są w nim powielane — pozostają w oryginalnych archiwach źródeł i mogą z nich odbudować cache. Odtwarzanie akceptuje również starsze pakiety bez cache; istniejącego cache nie nadpisuje w całości. Rozszerzono przygotowane wcześniej funkcje zapisu próby i odtwarzania runtime; ich połączenie z docelową publikacją i workflow pozostaje w etapie Releases.

Nowe wyniki powstają w `.public-state/build`. Dotychczasowa lokalna para NL/UE pozostaje dostępna podczas budowania i niezależnego audytu. Dopiero po PASS obu modułów następuje instalacja pary. Dziennik pozwala wycofać przerwaną instalację przy następnym wejściu; kontrolowany błąd odtwarza starą parę od razu. Nie zmienia to zdalnego wskaźnika aktywnej publikacji.

Program zapisuje `incremental-NL.json` i `incremental-EU.json`: URL/nazwę źródła, rozmiar, hash, datę sprawdzenia, Last-Modified, odebrane bajty i decyzję NEW/MISSING/CORRUPT/CHANGED/UNCHANGED/AUDIT. Raporty wykonania otrzymały osobne liczniki ponownego użycia parserów, modeli i walidacji. Sygnatury cache obejmują również binarne źródła, modele i wyniki walidacji.

### Weryfikacja kroku 3

Zaliczono 166 testów TypeScript, 52 testy Python i obie kontrole typów. W szczególności:

- niezależne procesy oraz odtworzenie runtime do nowego katalogu: niezmieniony przebieg odebrał **0 bajtów treści źródła**, użył jednego wyniku parsera, trzech przygotowanych modeli i wcześniejszej walidacji XML, zachowując checkpoint i poprzednią bazę;
- zmiana treści wymusiła ponowne pobranie i przetworzenie; pełny audyt ominął trwałe optymalizacje; uszkodzenie cache walidacji spowodowało rzeczywistą ponowną walidację;
- domyślna publiczna ścieżka RDF przetworzyła strumień większy niż dawny limit 64 000 000 bajtów, zachowując źródło na dysku i uzyskując pozytywną kontrolę grafu RDF w trybie STREAMING_FILE;
- testy wykryły i potwierdziły poprawki nadpisywania starszych bajtów, podmiany cache podczas 304, odtwarzania po przerwaniu instalacji oraz ochrony przed dowiązaniami;
- testy pakietu runtime potwierdziły zachowanie cache obliczeń oraz pominięcie powielonych surowych plików HTTP.

Są to testy lokalne, z kontrolowanym transportem HTTP i rzeczywistym walidatorem/schematami. Nie uruchomiono pełnego korpusu na GitHub Actions ani rzeczywistej publikacji. Oficjalne katalogi są nadal sprawdzane, a Markdown i kompletność pakietu nadal podlegają kontrolom. Serwer bez użytecznych walidatorów HTTP może wymagać odpowiedzi 200 i ponownego pobrania identycznych bajtów. Podłączenie ośmiu części cache do Actions oraz docelowej retencji pozostaje w etapie workflow/Releases.

## Poprawki kroku 1

- Ekstraktor obrazów UE tworzy pliki boczne w `images/`, zachowując wejściowy Markdown bez zmian. Brak możliwości pobrania obrazu jest błędem. Kontrola powiązań odrzuca niepełne lub powielone przypisania wystąpień, zmienione odwołania i niezgodne bajty pliku.
- Usunięto dodany wcześniej twardy próg 577 500 znaków i stałe celu 500 000 znaków. Test potwierdza zachowanie kompletnego artykułu przekraczającego wycofany próg. Dotychczasowy układ plików pozostaje przejściowo; nowy podział logiczny wymaga odrębnego wdrożenia.
- Poprawiono otwieranie pliku podczas strumieniowego obliczania SHA-256 XML: zgodność typów TypeScript, odczyt przez otwarty deskryptor, zamknięcie deskryptora oraz zachowanie kontroli zmiany pliku.
- Dostosowano test sprzątania do zachowania cache, checkpointów i wyników. Test sprawdza również, że usunięcie dowiązania katalogu roboczego nie usuwa jego zewnętrznego celu. Domknięto uchwyt pliku w nowym teście XML.

## Ocena rozpoczętych mechanizmów

| Obszar | Obecny stan i pozostała praca |
| --- | --- |
| Cache i checkpointy | Wdrożono plikowy cache, odtwarzanie źródeł z archiwów, trwały cache obliczeń/pozytywnych walidacji i pakiet runtime. Potwierdzono ponowne użycie po odtworzeniu do nowego katalogu w osobnym procesie. Pozostaje połączenie ośmiu części cache i docelowej retencji z workflow. |
| Strumieniowy RDF/XML | Publiczny punkt wejścia wybiera nową ścieżkę plikową bez programowego limitu źródła. Sprawdzono ją przez rzeczywisty walidator na RDF przekraczającym dawny limit 64 MB. To nie jest dowód przetworzenia dowolnie dużego RDF na runnerze. |
| Releases i retencja | Pomocniki oraz testy lokalne istnieją. `public_github.py` oczekuje `distribution.json`, którego `github-build.ts` jeszcze nie tworzy. Workflow nie dostarcza tokenu do przygotowania odtwarzającego stan v2, nie odtwarza/zapisuje cache i nie wywołuje nowej retencji. Nie jest to gotowa ścieżka publikacji. |
| Zakres pełnych aktów/spraw | Wdrożono rozszerzenie pobrania przy zachowaniu selektorów: wszystkie artykuły NL z pełnymi oryginałami oraz pełne dokumenty UE z katalogiem formalnej przynależności do sprawy. Pozostaje odbiór pełnego korpusu i pełny model pozostałych jednostek NL w Markdown. |
| Podział logiczny i manifest | Nie wdrożono nowego modelu/manifestu i odtwarzania pełnych wersji. Wciąż działa wcześniejszy podział według wielkości/liczby jednostek. Nie należy przedstawiać go jako realizacji nowego kontraktu. |
| Języki UE | Dodano kolejność EN→PL→NL→FR, ale niezależny audytor i raport dostępności nadal zakładają EN. Powiązania reprezentacji uzupełniających trzeba rozróżniać również według języka. |
| Bezpieczne białe znaki | Pomocnik zachowuje wrażliwe odstępy, ale walidatory końcowe nadal wymagają globalnej normalizacji. Wymaga to uzgodnienia przy integracji bez osłabiania integralności tekstu. |
| Obrazy | Ekstraktor UE i kontrola jego powiązań działają jako pomocniki. Nie wdrożono pełnego `IMAGE_INDEX.json`, powiązań źródło–wersja–jednostka–Markdown ani połączenia z przebiegiem NL/UE. Kopiowanie bajtów nie zastępuje niezależnego sprawdzenia rzeczywistego formatu/poprawności obrazu. |
| Paczki i bramka końcowa | Pozostają archiwa per akt; nie powstają jeszcze jedna zbiorcza paczka źródeł NL i jedna UE. Pełna walidacja nowego pakietu przed publikacją nadal wymaga implementacji. |

## Weryfikacja kroku 1

- TypeScript: główny projekt i narzędzia — bez błędów.
- 92 testy TypeScript: obrazy, języki, integralność, optymalizacja, parser UE, tożsamość cache, cache pochodnych, integracja walidatora XML i integralność ZIP — zaliczone.
- 50 testów Python: publiczne operacje/publikacja/retencja/cache (42) i walidacja plikowa XML/RDF (8) — zaliczone. Operacje zdalne w tych testach są zastępowane obiektami testowymi; testy Git używają lokalnych repozytoriów tymczasowych.
- `git diff --check` — bez błędów.

To testy lokalne wybranych ścieżek, nie odbiór pełnego publicznego przebiegu ani dowód kompletności pobranego korpusu. Nie uruchomiono GitHub Actions, nie wykonano publikacji, push, merge ani długotrwałego eksperymentu retencji.

## Następne kroki

1. Wdrożyć pełny model struktury prawnej, podział naturalnymi granicami, manifest jednostek, odtwarzanie wersji i usuwanie nieaktualnych części. Uwzględnić pozostałe kontenery NL, tabele, przypisy i załączniki.
2. Zintegrować bezstratne wyodrębnianie obrazów NL/UE, pełny `IMAGE_INDEX.json` i nawigację przygotowywaną przed zamrożeniem Markdown.
3. Uzgodnić końcowe walidatory z chronionymi odstępami oraz audyt źródeł z faktycznym językiem i reprezentacjami uzupełniającymi. Utworzyć jedną zbiorczą paczkę źródeł NL i jedną UE oraz końcową bramkę integralności całego pakietu.
4. Połączyć generator dystrybucji, Releases i indeks `dane` z trwałym stanem workflow i ośmioma częściami cache. Zapewnić retencję dwóch ostatnich prób i chronionej aktywnej bazy oraz sprzątanie cache 7→4 GB.
5. Przeprowadzić końcowe kontrole całego przebiegu i uzgodniony test publiczny, bez ustawiania harmonogramu i bez osobnego długotrwałego eksperymentu retencji.

Nie uruchamiano Actions, publikacji, push ani merge. Nie zmieniono prywatnego repozytorium.

Użyte Skills: `codex-engineering-guardrails:code-work` i `code-verification` — poprawki oraz weryfikacja rozpoczętego kodu; `cloud-environment:cloud-environment-runtime` — obsługa dostępnego środowiska. Użyta wtyczka: Cloud Environment. Nie była potrzebna wtyczka do Drive ani dodatkowe usługi.

W kroku 2 użyto Skill `codex-engineering-guardrails:code-work` do wdrożenia i testów zmiany oraz wtyczki Exa do wyszukania kontekstu oficjalnych źródeł. Właściwe relacje spraw potwierdzono bezpośrednim odczytem oficjalnego endpointu SPARQL CELLAR. Narzędzia GitHub i Drive nie były potrzebne do lokalnego wdrożenia.

W kroku 3 użyto Skill `codex-engineering-guardrails:code-work` do wdrożenia i weryfikacji oraz lokalnych narzędzi Node/Python/Git. Wtyczki zewnętrznych usług nie były potrzebne. Sprawdzono aktualny wykaz narzędzi oraz katalog Skills i potwierdzono odczyt `code-work`. Katalog Skills zgłosił ograniczenie kompletności; obecność narzędzi GitHub nie jest potwierdzeniem wszystkich uprawnień ani dostępu do wszystkich wtyczek/Skills na koncie użytkownika.
