# Dziennik naprawy publicznego aktualizatora NL i UE

## 19.11.2026 · Punkt odniesienia

- Lokalny checkout startował z `cc33a70`. GitHub wskazał nowszy `main` `c1d52642047ca18de58f4bde3e855931e705bb40`; jego sześć dodatkowych plików dotyczy archiwizacji i uzgadniania raportów. Prace lokalne oparto na nowszym SHA.
- `dane` `824aca70944604b5499e47c0c27dcf0dd7bfe689` zawiera 404 regularne pliki. NL ma 53 pliki (40 330 538 B), UE 348 (51 267 452 B), trzy pliki są w katalogu głównym. Największy plik to `NL/15_BWBR0001827.sources.zip` (10 924 746 B).
- PR #16 i #18 są otwarte. Sprawdzenia `verify` i `SonarCloud Code Analysis` na zastanym `main` zakończyły się sukcesem.
- Narzędzia pracy to Code Work, Git, odczyty przez GitHub CLI i lokalne testy Node/Python. SonarCloud i Actions służą do sprawdzenia odpowiadającego im SHA. Odbiór danych wymaga osobnego audytu.
- Kolejność prac obejmuje walidatory i cache, dwufazową inicjalizację, niepewność terytorium i języków, przygotowanie i audyt migracji oraz test atomowego zapisu na lokalnym repozytorium bare. Publikacja produkcyjnego `dane` wymaga odrębnej zgody i audytu zgodnie z §2.4.
- Pierwsze `npm ci` nie mogło zapisać domyślnego cache w katalogu domowym. Powtórzono instalację z cache w `/tmp` bez zmian w lockfile.

## 19.11.2026 · Walidatory i cache

- Z PR #16 zastosowano strażniki pięciu audytorów, które odrzucają interpreter z wyłączonymi asercjami, wraz z regresją dla `python -O`. Zmiany pakowania dystrybucyjnego z PR #16 pominięto.
- Z PR #18 zastosowano zmiany kodu, workflow i testów usuwające własne przycinanie cache. Osiem shardów oraz podpisy zawartości pozostały w przepływie.

## 19.11.2026 · Inicjalizacja, publikacja i kontrola źródeł

- Publiczny kontroler uruchamia BASE na `rangeFrom` i UPDATE na `rangeTo`, gdy brak zweryfikowanej bazy. Aktualizacja istniejącej bazy korzysta z jednej fazy. Osobne katalogi faz i potwierdzenia audytu chronią przed publikacją półbazy.
- Na prawdziwym XML NL odtworzono błąd art. 6a BWBR0002638 w kroku BASE. Dobór zakresu według wersji źródłowej pozwolił przejść przez wszystkie 23 akty NL. W kontrolowanej próbie jednego aktu NL faza UPDATE znalazła art. 6a i pięć stanów aktu.
- Publiczny przepływ używa plików źródłowych według SHA-256, niezależnego audytu plików i weryfikacji oryginalnych ZIP Formex. Próba na prawdziwych źródłach ujawniła brak obsługi strumieniowego odczytu RDF w adapterze plikowym. Po dodaniu tej ścieżki audyt zaliczył BASE i UPDATE dla pary BWBR0002638 i 32003L0088.
- Z wyników tej pary przygotowano 101 plików w lokalnym repozytorium bare. Commit `958340c6f8ffd589c7e7d039cf9d75d77c6f0cb2` przeszedł płytkie odtworzenie. Po porównaniu z aktualnym zbiorem zmian prawnych było zero. Historia obu modułów była dostępna przez indeksy.
- Zweryfikowano 596 członków 88 historycznych paczek ze zdalnego `dane` o SHA `824aca7`. Przeniesione do oddzielnych obiektów źródłowych bajty przeszły kontrolę SHA-256. Teksty wynikowe odtworzyły się bajtowo. Gdy kod przygotowuje migawkę, łączy indeksy historyczne i porównuje rozmiary folderów przed atomową publikacją.
- Publiczne języki UE zależą od aktywnych modułów. Niejednoznaczna stosowalność pozostaje oznaczona `APPLICABILITY_UNKNOWN`. Oficjalne dane CELLAR dla przykładów 32026D1108, 32025D2591 i 32009D0459 potwierdziły różne predykaty i formaty adresatów. Zakres skutków prawnych poza adresatami wymaga osobnych dowodów.
- Powłoka była chwilowo niedostępna. Po odzyskaniu połączenia log potwierdził zbudowanie fazy BASE dla 23 aktów NL i 63 pozycji UE. Dwie pozostałe pozycje konfiguracji UE miały daty dokumentów późniejsze niż data BASE. Wynik z modułów jest wcześniejszy niż niezależny audyt pary.
- Profil CPU pełnego przebiegu wykazał powtarzany parsing HTML przy normalizacji i kontroli linków. Zmieniono ścieżkę identycznych bajtów i ograniczono powielone parsowanie. Jednorazowy pomiar na 32 rzeczywistych częściach TFUE dał 2 565 ms przed zmianą i 114 ms po zmianie, z dokładnie identycznym tekstem wyjściowym.
- Dostępna kontrola GitHub wykazała widoczność głównego adresu konta `public`. Dane o Secret scanning i Push protection nie były dostępne przez API. Ustawienia konta nie były zmieniane.
- Pełna migawka fazy BASE przeszła niezależny audyt po skorygowaniu weryfikacji klucza grafiki. Klucz uwzględnia teraz identyfikator dokumentu, język, wersję, locator i sumę SHA-256 dowodu źródłowego przy urzędowym fallbacku. Liczby z audytu BASE to 23 akty NL (98 źródeł), 63 pozycje UE (481 źródeł) i 0 niedostępnych grafik.
- Dla `32006L0054` urzędowy indeks CELLAR potwierdził zachowanie oryginału z 2006 r. i wersji `02006L0054-20060726` po obu stronach granicy. Selektor dodaje `02006L0054-20260619` od 19.06.2026 i zachowuje `32024L1500` oraz cztery sprostowania.
- Próba pełnego UPDATE odsłoniła brak oficjalnych XSD Formex 05.01 i 05.20. Dodano oryginalne, niespakowane schematy, ich sumy i regresje na przechwyconych XML. Dwa odrzucone wcześniej kontenery Formex 05.20 zaliczyły walidację wszystkich swoich 9 XML. Uzgodnienie procesu Node/Python sprawdza rzeczywisty hash katalogu i liczbę 35 schematów. Źródła: https://formex.publications.europa.eu/schema/formex-05.01-20091201.xd i https://formex.publications.europa.eu/schema/formex-05.20-20100601.xd .
- Oryginał `32006L0025` został odrzucony we wszystkich trzech językach na dokładnym placeholderze `javascript:void(0);`. Regresja zachowuje tekst oraz wartość jako nieaktywny atrybut i nadal odrzuca dowolny inny skrypt w odnośniku. Powtórzone pobranie tego aktu przez aktualny loader dało 7 części EN, potwierdzony element WEMI, oryginalne XHTML/RDF/Formex i zero problemów w raporcie źródeł.

## 19.11.2026 · Stan kryteriów odbioru

| Obszar | Dowód i pozostały zakres |
|---|---|
| C01–C02 | Testy lokalne odrzucają zoptymalizowanego Pythona dla pięciu audytorów. Workflow używa ośmiu shardów i podpisów, bez kroków przycinania. |
| C03, C09–C10 | Sprawdzono odtworzenie poprzednich plików i źródeł z `dane`. Lokalny ref przyjął dane bez ZIP. Bramki rozmiaru odrzucają spadek osobno dla NL i UE. Migracja istniejącego ref pozostaje zależna od potwierdzonej zmiany prawa albo osobnej decyzji. |
| C04–C06 | Testy lokalnego ref wykazały jeden commit po sukcesie, zero zapisów po błędzie drugiej fazy i ten sam SHA po NO_CHANGE. Szybki preflight jest ograniczony do potwierdzonych odpowiedzi 304 dla zgodnego zakresu i zweryfikowanych obiektów. Inne przypadki trafiają do pełnej kontroli. |
| C07–C08 | Scope UE obsługuje EN/FR oraz EN/FR/NL i sprawdzane wykluczenia językowe. Potwierdzenie adresata NL i brak dowodów terytorialnych są raportowane oddzielnie. Typowane obserwacje dat zachowują oryginalne wyniki zapytań głównych i spraw sądowych. Pełne ustalenie skutków na poziomie jednostki i wyłączności terytorialnej pozostaje otwarte. |
| C11 | Obie fazy przeszły na rzeczywistych urzędowych źródłach dla jednej pary NL+UE i trafiły do odizolowanego Git. Test regresji sprawdza awarię drugiej fazy i pojedynczy UPDATE przy poprawnej bazie. |
| GitHub i SonarCloud | Zielone kontrole autora repozytorium dotyczą odczytanego SHA istniejącego `main`. Zmiany robocze zweryfikowano lokalnie. |

## 19.11.2026 · Wyniki lokalne i rozmiar

- Wykonano `npm run typecheck`, `npm run typecheck:tools`, `npm run parser:selftest`, `npm test` (441 zaliczonych), pełny zestaw Python (162 zaliczone) i `npm run test:xml` (18 integracji Node i 36 testów Python). Przejściowy timeout startu Pythona podczas równoległych testów sprawdzono osobnym przebiegiem. Zestaw XML zaliczył również po dodaniu schematów 05.01 i 05.20.
- Niezależny audyt NL po pełnym UPDATE zwrócił COMPLETE dla 23 aktów, 146 źródeł i 4 965 plików. Pomiar po lokalnym połączeniu z historycznym NL dał wzrost z 40 330 538 B do 540 997 303 B. W tej próbie było 5 021 plików, największy miał 35 293 882 B. Plików powyżej 50 MiB było zero. Wzrost wynika z pełnych wersji, indeksów i oddzielnych dowodów źródłowych.
- Jedna migawka z rzeczywistej pary testowej została wypchnięta wyłącznie na lokalny Git bare. Zdalne `main` i `dane` mają nadal odczytane na początku SHA. Testy nie włączyły harmonogramu ani nie używały prywatnego repozytorium.
- Powtórzony pełny UPDATE zbudował 23 akty NL (4 965 plików) i 65 pozycji UE (1 914 plików). Odrzucone w nim dwa pakiety Formex 05.55 zawierały sześć XML. Wszystkie sześć zaliczyło audyt z dokładnym oficjalnym schematem 05.55 pobranym po rozpoczęciu próby. Checkpoint z odrzuconą reprezentacją wymaga teraz ponownej próby pobrania i walidacji tego aktu. [Formex 05.55](https://formex.publications.europa.eu/schema/formex-05.55-20141201.xd)
- Audyt tej próby wykazał NL COMPLETE, UE PARTIAL, 0 niedostępnych grafik i dokładnie 2 nierozstrzygnięte źródła. Były to Formex dla `32016R0589` i `32016R0679`. Walidacja 36 przypiętych schematów oraz regresja wznowienia przeszły lokalnie. Po tych zmianach zaliczono 442 testy Node, 163 testy Python, 18 integracji XML Node i 37 testów XML Python.
- Próba pełnej fuzji na dysku z zachowanym wynikiem diagnostycznym potwierdziła indeksy i hashe historyczne. NL wzrósł z 40 330 538 do 545 729 809 B, UE z 51 267 452 do 189 068 483 B. Drzewo zawierało 7 465 plików, zero ZIP i największy plik 35 246 131 B. Kandydat tej próby miał status PARTIAL, więc służył wyłącznie do weryfikacji modelu przechowywania.
