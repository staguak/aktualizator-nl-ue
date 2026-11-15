# Etap 4: struktura prawna Markdown i manifest jednostek

## Nadrzędna aktualizacja wymagań — 2026-11-15

Wznowiono na polecenie użytkownika. Etap 2: odzyskano klamrę z polskiego oryginału; etap 3: wdrożono pełny tekst, natywne Base64 i odwracalną prezentację z niezależnym audytem. Aktualne raporty: `docs/EU_FALLBACK_STAGE2_20261115.md` i `docs/INLINE_BASE64_STAGE3_20261115.md`. Niepełne checkpointy są ponawiane, awarie cache nie są maskowane jako brak źródła, a PARTIAL nie zastępuje chronionej poprawnej publikacji. Historyczne kandydaty NL i UE przechodzą osobne audyty; wspólny odbiór pozostaje do wykonania z powodu różnicy dat końcowych. Nie zmieniono dat w celu uzyskania PASS. Zachowano 160 historycznych ostrzeżeń UE do przeglądu w etapie 4.

Kolejne polecenie użytkownika — korekta nagłówków przed etapem 4: rozpoznawać początkowe tytuły z oryginałów (w tym konsolidacje i wyroki), zapisywać tytuł/proweniencję przy każdym dokumencie, rozdzielić datę dokumentu/konsolidacji/publikacji, renderować dane konkretnego dokumentu i sprawdzać je z zachowanym XHTML oraz surowymi odpowiedziami metadanych. Unieważnić stare wyniki parsowania, wymagać przebudowy albo zweryfikowanej migracji checkpointów, zachować surowy cache, wykonywać korektę przed Base64. Wykonać test zachowanego pakietu UE i zdać raport `docs/EU_DOCUMENT_HEADERS_20261115.md` przed rozpoczęciem wspólnego przebiegu NL/UE. Wspólny przebieg pozostaje wstrzymany na tym punkcie kontrolnym.

Bieżący zakres: dokończyć etap 2 i zdać raport, następnie wykonać etap 3 i zdać osobny raport. Finalny Markdown ma zawierać grafiki Base64 i pełną treść zamiast plików UE-REF będących samym odnośnikiem. Base64 koduje oryginalne bajty JPEG/PNG/SVG/innych formatów, bez konwersji. Oryginalne źródła pozostają niezmienione; wcześniejsza niezmienność finalnego Markdown ustępuje nowemu wymaganiu. Zmiana prezentacji musi być kontrolowana, odwracalna i opisana w indeksie. Struktura prawna, wersje, treść i kolejność nadal podlegają sprawdzeniu z oryginałami.

Brakujący/niekompletny dokument lub grafika: skonfigurowane źródła EN → PL → NL → FR, zakończenie po pierwszym poprawnym wyniku. Grafika z innego języka musi pochodzić z tego samego aktu i wersji oraz odpowiadającej jednostki; zachować dowód pochodzenia. Gdy próby zawiodą, zapisać problem i kontynuować pozostałe pozycje. Brak oznaczyć jawnie, bez martwego linku zastępującego treść i bez deklaracji pełnej kompletności. Wyjątek dla dekoracyjnych flag nadal obowiązuje. Awaria infrastruktury i naruszenie integralności dostępnych treści nie stają się automatycznie brakiem źródła.

Pozostałe kroki: (2) odzyskiwanie, kontynuacja i dowody braków; (3) Base64/pełny tekst, odwracalne renderowanie, MIME, indeksy i niezależna walidacja; (4) pełny odbiór NL/UE i regresja; (5) PR/CI i test publiczny; (6) dystrybucja, cache i zwykłe sprzątanie. Bez harmonogramu, prywatnego repo i eksperymentu retencji. Starsze sekcje są historią decyzji i nie nadpisują tej aktualizacji.

Zatwierdzony zakres: publiczny aktualizator NL/UE. Bez publikacji, merge, zmiany prywatnego repo, harmonogramu ani osobnego eksportu jednostek. Zachować źródła, wersje, kolejność, tabele, odsyłacze i obrazy. Granice plików mają być logiczne; 95 MB pozostaje zabezpieczeniem technicznym, nie celem pakowania. Dopuszczalny podział dużej jednostki tylko według jej rzeczywistych dzieci; brak bezpiecznej granicy blokuje publikację.

## Decyzje

- Wersjonowany profil `legal-structure-v1`, włączony w publicznej konfiguracji; odczyt starszych manifestów i dotychczasowe ścieżki pozostają dostępne.
- Wspólny katalog jednostek: korpus, akt/dokument, wersja i język, rodzic, rodzaj, etykieta, kolejność, identyfikatory źródłowe, lokalizator, powiązania z częściami. ID niezależne od fizycznych nazw plików.
- NL: pełne, osobne stany XML; czytelny widok HTML w Markdown zachowuje mieszany tekst, strukturę, tabele i zasoby. Istniejące sprawdzenia selektorów i historii artykułów nadal działają.
- UE: rozpoznanie kontenerów i nagłówków EN/PL/NL/FR; pełne artykuły, motywy, załączniki, orzeczenia, tabele i przypisy. Zachować działające sprawdzenia tożsamości, treści, obrazów i nawigacji.
- Manifest przechowuje dokładny przepis rekonstrukcji każdej wersji i zakresy jednostek. Porównanie oryginału, modelu i odtworzonego wyniku stanowi warunek przyjęcia; sama zgodność liczby jednostek nie wystarcza.

## Kolejność i kryteria

1. Wspólny model/manifest i odtwarzanie: jednoznaczne ID, poprawna hierarchia, kolejność, rozłączne pokrycie części; negatywne testy braków, powtórzeń i podmiany. Pliki: nowy moduł struktury i test.
2. Widok pełnego stanu NL: preambuła, rozdziały, artykuły/ustępy/punkty, załączniki/tabele/obrazy; zachowanie tekstu i źródłowych identyfikatorów. Pliki: nowy parser strukturalny NL i test.
3. Renderowanie/manifest NL: naturalne granice i osobne wersje, indeks jednostek, istniejące selektory i kontrola kompletności ze źródłem. Zależności: 1–2.
4. Widok UE: kontenery/nagłówki oraz rozpoznanie jednostek i naturalny podział bez celów znakowych. Integralność wszystkich treści i zasobów. Zależność: 1.
5. Renderowanie/manifest UE: integracja nawigacji i deduplikacji z lokalizatorami jednostek i przepisem odtworzenia. Zależności: 1, 4.
6. Walidacja/checkpointy: poprawne przyjęcie nowego profilu i odrzucanie utraty/duplikatów/złej wersji/odsyłaczy; nadal odczytywać stare dane. Zależności: 3, 5.
7. Publiczne wejścia/cache: włączenie profilu, zachowanie metadanych przy ponownym użyciu, usuwanie nieaktualnych części przez instalację całego zweryfikowanego zestawu. Zależność: 6.
8. Weryfikacja i raport: testy nowych kontraktów, regresja NL/UE, XML/checkpointy, kontrola typów i odtworzenie wybranych rzeczywistych źródeł. Nie wykonywać publikacji ani eksperymentu retencji.

Testy: repozytoryjne `npm run typecheck`, `npm run typecheck:tools`, `npm run parser:selftest`, odpowiednie `node --import tsx src/*.test.ts`, integracja XML i testy Python dotkniętych konsumentów. Listę postępu prowadzić w `tasks/todo.md`.

Ryzyka: mieszany XML NL i rzadkie struktury tabel; różne rodzaje XHTML UE; normalizacja/zmiana odsyłaczy po wyznaczeniu zakresów. Łagodzić przez zachowanie danych źródłowych, dokładne zakresy, finalizację indeksu po przygotowaniu widoku oraz niezależne porównanie treści i metadanych. Nie obniżać kontroli integralności w celu uzyskania PASS.

## Kontynuacja po etapie 4

Użytkownik polecił kontynuować kolejne etapy bez potwierdzeń między nimi. Zachowujemy bieżący plan i zapisujemy wyniki kolejno:

5. Obrazy NL/UE: bezstratne pliki graficzne, niezmienny Markdown/original, `IMAGE_INDEX.json` z powiązaniem do źródła, wersji i jednostek; grafiki wskazane w INDEX.
6. Paczka i audyt: walidacja pełnego pakietu, rzeczywiste języki EN→PL→NL→FR, jedna zbiorcza paczka źródeł na NL i UE; oryginały rozpakowane podczas audytu.
7. Dystrybucja: generator `distribution.json`, Releases i indeks `dane`, odtworzenie runtime/cache w workflow, retencja dwóch ostatnich prób oraz chronionej aktywnej bazy, cache po >7 GB do ≤4 GB. Bez harmonogramu; bez osobnego eksperymentu retencji.
8. Odbiór: końcowe kontrole lokalne i dostępny uzgodniony test publiczny; aktualizacja raportu i jawna lista ograniczeń/błędów.


## Wznowienie odbioru — plan do wykonania dopiero po kolejnym poleceniu użytkownika

Stan sprawdzony 2026-11-14: `main` wskazuje `ccc6363b73dac766045c1fe5411c514a563fe64d`; PR #7–#9 scalone. Robocza gałąź `fix-eu-native-images-20261114` zawiera niescaloną obsługę MIME `image/jpg` oraz test i oryginalną próbkę JPEG z proweniencją. Ostatni pełny publiczny run 43592013460 zakończył się OUTPUT_VALIDATION_FAILED po ukończeniu obu modułów (23 NL / 65 UE). Aktywna publikacja `dane` pozostaje poprawną starszą bazą, zakres 2025-01-01–2026-11-13, kod cddf701.

Baza dowodowa: pełna regresja na scalonym kodzie 347 Node / 97 Python PASS, obie kontrole typów i self-test BWB PASS. NL po wydzieleniu grafik: 4986 plików, 58 wystąpień / 20 natywnych grafik; niezależny audyt 144 źródeł / 203256600 bajtów / 0 ostrzeżeń PASS. UE: walidacja źródłowa 1556 plików / 135 dokumentów PASS; kompletne obrazy i publikacja pozostają nieodebrane. Nowsza lokalna poprawka MIME ma pozytywny test celowany (10 testów eu-assets) oraz odczyt natywnego JPEG; pełna regresja tej roboczej poprawki jeszcze nie została wykonana.

1. **Klasyfikacja i dowody brakujących grafik UE.** Sporządzić kompletny wykaz braków z CELEX, rolą obrazu i kodem HTTP; odróżnić grafikę nagłówka, znak grupowania tabeli i ilustracje/wzory. Nie uznawać odpowiedzi HTML 200 za grafikę. Narzędzia: GitHub + Exa, Codex Dev Workflows `bug-investigation`, Superpowers `systematic-debugging`. Odbiór: każda ścieżka ma potwierdzoną przyczynę i plan odzyskania oryginału.
2. **Dokładne odwołania do natywnych plików CELLAR.** Użyć urzędowych powiązań `owl:sameAs` między adresem obrazu z XHTML a kanonicznym elementem CELLAR. Zachować źródłowe adresy, oryginalne bajty, Markdown i dowód powiązania w indeksie. Dla odsyłaczy bez takiego dowodu zbadać właściwą reprezentację/paczkę; nie zgadywać pliku ani zamieniać grafiki na podobną. Narzędzia: Engineering Guardrails `code-work`, EngineeringSuite/Agent Skills do małych przyrostów, testy regresji Superpowers. Odbiór: pozytywne i negatywne testy tożsamości oraz rzeczywiste pobranie pliku wskazanego w RDF.
3. **Domknięcie MIME i walidacji indeksu.** Dokończyć roboczą normalizację `image/jpg` do `image/jpeg`, bez konwersji danych; sprawdzić pochodzenie i format JPEG, błędne MIME oraz brakujące/podmienione pliki. Uzupełnić bezpieczną diagnostykę. Narzędzia: Superpowers test-driven-development i code review; SimplyUtils tylko pomocniczo do małych publicznych wzorców, gdy przyniesie korzyść.
4. **Odbiór pełnego UE i pary NL/UE.** Powtórzyć końcową kontrolę źródeł, Markdown, indeksów i wszystkich grafik; wykazać niezmienność, dokładne pokrycie jednostek i rekonstrukcję wersji. Uruchomić odpowiednią regresję, oba sprawdzenia typów i niezależny audyt. Narzędzia: Engineering Guardrails `code-verification`, Superpowers verification-before-completion; odrębny przegląd zgodnie z requesting-code-review. Security Advisory Scout tylko przy zmianie zależności lub konkretnym alercie.
5. **CI i pełny test publiczny.** Dopiero po przejściu lokalnych kryteriów przygotować PR, wymagany check verify i integrację; następnie uzgodniony test Actions z odtworzonym stanem/cache. Zweryfikować także liczniki rzeczywistego ponownego użycia i pobierania. Narzędzia: GitHub; EngineeringSuite ci-cd-and-automation w razie koniecznych zmian workflow. Nie ustawiać harmonogramu.
6. **Kontrola dystrybucji i raport.** Sprawdzić cztery paczki Releases, ich SHA/rozmiary/zawartość, indeks dane wskazujący nowe poprawne wydanie, zakończenie blokady i zwykłe sprzątanie przebiegu. Potwierdzić zachowanie cache i poprzedniej dobrej bazy. Bez osobnego eksperymentu retencji. Zaktualizować raport wdrożenia i checklistę dopiero według wyniku, z jawną listą pozostałych błędów/ostrzeżeń i faktycznie użytych wtyczek.

Aktualizacja decyzji 2026-11-14, podczas etapu 2: użytkownik wyraźnie zrezygnował z wymogu pobierania dekoracyjnych flag. Można je pomijać z jawnym wpisem w indeksie, bez zmiany oryginałów i Markdown. Wyjątek nie obejmuje znaku grupującego tabelę (`r1.jpg`, alt „right accolade”) ani innych elementów dokumentu. Wcześniejsze zapisy etapu 1 opisują stan sprzed tej decyzji.

Dostępność: odczytano instrukcje EngineeringSuite, Engineering Guardrails, Codex Dev Workflows i Agent Skills; bieżące narzędzia obejmują GitHub, Exa, Security Advisory Scout i SimplyUtils. Katalog chmurowy jest stronicowany i zgłasza obcięcie, dlatego nie zakładamy dostępu do wszystkich dawniej wymienionych wtyczek. Programming Hub, OGENIC GOD TOOLKIT i Prompt Machine nie mają potwierdzonych samodzielnych narzędzi w tej sesji. EngineeringSuite deklaruje zestaw umiejętności AI Hero / Matta Pococka; nie dowodzi to dostępności osobnej wtyczki Matt Skills Curated.

## Wynik etapu 1 — 2026-11-14

Użytkownik zlecił wykonanie wyłącznie pierwszego etapu i raport. Diagnoza zakończona; następne etapy pozostają niewykonane. Pełny raport i wykaz: `docs/EU_IMAGE_DIAGNOSIS_20261114.md` oraz `.csv`; lokalne dowody: `/workspace/publication-review/stage1-eu-images/`.

Zbadano 130 wystąpień obrazów (125 fizycznych), w tym 71 osadzonych JPEG i 59 wystąpień zewnętrznych pod 54 adresami. Wszystkie osadzone ładunki są poprawne, ale scalony kod nie przyjmuje ich deklaracji `image/jpg`. 31 adresów zewnętrznych zwraca HTTP 400 dla `Accept: image/*`, a HTTP 200 i natywne JPEG dla `image/jpeg`; dokładne powiązanie RDF, właściwy CELEX/język/reprezentacja i identyczność bajtów alias–kanoniczny CELLAR potwierdzone 31/31. Daje to 29 różnych zewnętrznych grafik, łącznie 100 dostępnych różnych natywnych plików.

**Korekta kierunku etapu 2 na podstawie dowodów:** zacząć od bezpiecznego transportu HTTPS dla urzędowych źródłowych odwołań HTTP i obsługiwanej negocjacji MIME, zachowując oryginalny URI/Markdown/bajty. Nie wymuszać dodatkowego SPARQL przy każdym pobraniu, jeśli alias po poprawnym żądaniu zwraca dokładnie ten sam plik. Potwierdzone powiązania RDF służą dowodowi i ewentualnej ścieżce rezerwowej. Nadal wymagane testy ograniczeń hostów, MIME, tożsamości i integralności.

23 adresy nadal nierozwiązane: 22 flagi (27 wystąpień) oraz `r1.jpg` (1 wystąpienie) w załączniku VIII `01992L0058-20190726`. Wszystkie sprawdzone adresy manifestacji zwracają 404; wspólne kandydaty EUR-Lex zwracają 202/HTML, bez natywnych obrazów. Nie oznacza to dowodu trwałego usunięcia wszystkich urzędowych kopii. Formex potwierdza znaczenie klamry jako grupowania tabeli: `ACCV="004.R.R"`, `ROWSPAN="4"`; paczka XHTML nie zawiera brakującej grafiki. Nie wolno utożsamiać jej z dekoracyjną flagą ani zmieniać zasad kompletności bez rozstrzygnięcia.

**Doprecyzowanie etapu 3:** niezależny audyt obrazu wymaga jednego dokumentu po `(documentId, version, language)`, podczas gdy pięć rzeczywistych wersji dokumentów jest współdzielonych przez dwa zakresy. Potwierdzono dwa dopasowania dla każdej z pięciu pozycji. Poprawka musi zachować wszystkie kontrole pochodzenia/jednostek i prawidłowo obsłużyć współdzielenie; to przyszła blokada audytu, nie przyczyna wcześniejszego błędu pobierania.

W etapie faktycznie zastosowano Codex Dev Workflows `bug-investigation`, Engineering Guardrails `code-verification` i Exa do urzędowej dokumentacji. Analizy wykonano lokalnym Node/Python i walidatorem obrazów aplikacji. Nie zmieniano kodu ani testów, nie uruchamiano Actions/publikacji ani eksperymentu retencji.

## Wynik etapu 2 — 2026-11-14

Raport: `docs/EU_IMAGE_RECOVERY_20261114.md`. Wykonano poprawkę transportu HTTPS i negocjacji MIME, natywne sprawdzanie odpowiedzi i zachowanie limitu 95 MB także dla SVG w publicznym cache. Pierwotny URI, dowód odpowiedzi kanonicznej i natywne bajty pozostają w indeksie; Markdown nie jest przepisywany. Nie dodano obowiązkowego SPARQL w normalnym pobieraniu.

Na dodatkowe wyraźne polecenie użytkownika wdrożono pomijanie dekoracyjnych flag nagłówków Dziennika Urzędowego UE. `IMAGE_INDEX.json.omittedDecorations` zapisuje tożsamość/wersję, URI, SHA i pozycje oraz powód wyjątku. Walidator TypeScript sprawdza te wpisy z treścią; starsze indeksy nadal są czytane. Wyjątek ograniczony do flag nagłówka na znanych hostach, z rozpoznanym kontekstem; nie obejmuje ilustracji w artykułach, wzorów ani klamer.

Dowody rzeczywiste: 31/31 dostępnych aliasów pobranych przez poprawiony loader, bajty i kanoniczne URI zgodne z etapem 1. Powtórka na końcowym kodzie: 31/31 HTTP 304 i 3 164 777 bajtów z izolowanego cache. Kontrola obrazów 135 dokumentów: 134 PASS, 27 jawnych pominięć / 22 adresy flag; 1284 odczytane Markdown i manifest niezmienione. Testy celowane: 45 Node i 2 Python PASS, oba typechecki PASS. Dowody/skrypty/logi: `/workspace/publication-review/stage2-eu-images/`.

**Otwarte:** `r1.jpg` w załączniku VIII `01992L0058-20190726` nadal ma HTTP 404. Nie ma kompletnego pakietu ani podstaw do publikacji. Wymagane odzyskanie dokładnego oryginału lub osobne rozstrzygnięcie reprezentacji źródłowego grupowania Formex. Etap 3 ma również zweryfikować nowe pominięcia w niezależnym audycie Python oraz prawidłowo obsłużyć współdzielone dokumenty. Robocza normalizacja `image/jpg` jest zachowana i przechodzi test celowany, ale nie została scalona. Pozostałe etapy odbioru, CI i dystrybucji bez zmian.

Użyto Codex Dev Workflows `resume-interrupted-task`, `bug-investigation`, `feature-testing`, Exa oraz lokalnego Node/Python. Bez Actions, push, PR, merge, publikacji, harmonogramu, zmian prywatnego repo i eksperymentu retencji.
