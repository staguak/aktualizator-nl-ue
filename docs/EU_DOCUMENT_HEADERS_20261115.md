# Tytuły i daty dokumentów UE — 2026-11-15

Zakres: sprawdzenie i naprawa całego przepływu nagłówków publicznego aktualizatora UE, przed wspólnym przebiegiem NL/UE. Zmiany są lokalne na gałęzi `fix-eu-native-images-20261114`. Nie uruchomiono nowego pobierania obu korpusów, Actions, publikacji, push, PR ani merge.

**Status: zakończone lokalnie. Wszystkie sześć punktów uzupełniono w publicznym przepływie strukturalnym UE; końcowa walidacja aplikacyjna i niezależny audyt poprawionego rzeczywistego pakietu zakończyły się PASS.**

## Co istniało, a czego brakowało

| Punkt | Stan przed poprawką | Wprowadzone uzupełnienie |
| --- | --- | --- |
| 1. Tytuł z oryginału | Parser rozpoznawał `doc-ti`, `oj-doc-ti`, `title-doc`, zbierał najwyżej trzy akapity, następnie używał HTML `title`. | Początkowy ciągły blok, również `title-doc-first`, `title-doc-last`, `coj-sum-title-1`; bez nagłówków załączników, artykułów i spisu treści. Obsługa starszych urzędowych stron z CELEX w H1 i tytułem w STRONG. Nazwa pliku lub CELEX są końcowym rozwiązaniem awaryjnym. |
| 2. Dane dokumentu | `parsed.sourceTitle` nadpisywał wyłącznie wspólny tytuł rodziny. | Każdy dokument ma `header` profilu `eu-document-header-v1`: tytuł, dokładne fragmenty, ich położenie w blokach XHTML, adres i SHA-256 oryginału oraz osobne dane dat. Tytuł rodziny pozostaje etykietą z konfiguracji. |
| 3. Daty | Oryginalne pola metadanych i funkcja wyboru `documentDate()` już istniały; nie tworzyły trzech niezależnych, zweryfikowanych dat nagłówka. | Data dokumentu wyłącznie z `work_date_document` właściwego CELEX; data konsolidacji wyłącznie z CELEX warstwy; data publikacji z jawnie dopuszczonych pól publikacji. Bez używania `documentDate()` jako daty przyjęcia i bez pobierania dowolnej napotkanej daty. |
| 4. Renderowanie | Części otrzymywały tytuł `entry.act.title`; wspólny renderer strukturalny nie rozróżniał semantyki dat UE. | Model przenosi tytuł konkretnego dokumentu do każdej części. Osobna nakładka UE wypisuje trzy opisane daty. Wspólny renderer NL pozostał niezmieniony. Indeks pokazuje etykietę rodziny oraz tytuły/datowanie dokumentów. |
| 5. Walidacja | Odtwarzano strukturę, treść i tożsamość źródła, ale nie sprawdzano wygenerowanego nagłówka. | Nagłówek i jego dane są odtwarzane z zachowanego XHTML oraz surowych odpowiedzi CELLAR-SPARQL/katalogu spraw. Sprawdzany jest cały wygenerowany prefiks każdej strukturalnej części. Python niezależnie odtwarza tytuły i daty. Sama zgodność z manifestem nie wystarcza. |
| 6. Cache/checkpointy/Base64 | Fingerprint parsera oraz kontrola źródłowych checkpointów już istniały. | Moduł nagłówków i kalendarz dodano do hashowanych zależności EU. Stary checkpoint bez nagłówka jest odrzucany do przebudowy; kontrolowana migracja może uzupełnić go ze zweryfikowanych oryginałów, bez nadpisywania istniejących nagłówków. Nagłówki powstają przed Base64. Surowy cache nie jest usuwany. |

## Semantyka i pochodzenie dat

`header.dates.document.fields.work_date_document` dotyczy konkretnego dokumentu, także sprostowania lub komunikatu. Data pełnego wyroku nie jest kopiowana do innego dokumentu tej samej sprawy. Dla konsolidacji to data dokumentu warstwy, a nie automatycznie data przyjęcia aktu podstawowego.

`header.dates.consolidation` wynika z daty w identyfikatorze skonsolidowanej wersji. Nie korzysta z dowolnych pól metadanych. Dokumenty nieskonsolidowane nie otrzymują zmyślonej daty konsolidacji.

`header.dates.publication` korzysta z pól `official-journal-act_date_publication` i `resource_legal_date_publication` powiązanych z właściwym CELEX. Brak, niepoprawna wartość albo sprzeczne wartości nie dają potwierdzonej daty. Manifest zachowuje wartości i status rozstrzygnięcia; nagłówek pokazuje, że data jest niepotwierdzona. Program nie wylicza publikacji z daty wspomnianej w tytule, daty przyjęcia, daty utworzenia rekordu ani daty konsolidacji.

Walidator ponownie wybiera odpowiednie wiersze surowych odpowiedzi, a nie wygenerowaną kopię metadanych. W przypadku jawnie niedostępnego katalogu źródeł daty z tego katalogu pozostają niepotwierdzone; nie blokuje to przetwarzania dostępnych dokumentów ani dotychczasowej obsługi braków.

## Weryfikacja

Testy obejmują EN/PL/NL/FR, różne dokumenty jednej rodziny, konsolidację, sprostowanie, pełny wyrok oraz komunikat w tej samej sprawie. Sprawdzane są długie bloki tytułowe, oddzielenie cytowania publikacji na starszych stronach, brak/niejednoznaczność/niepoprawność dat, zachowanie grupującej etykiety rodziny, checkpointy oraz wynik po osadzeniu Base64.

Testy negatywne zmieniają sam wygenerowany tytuł albo datę i przeliczają metadane pliku. Walidacja aplikacji nadal odrzuca taki wynik. Fałszywy nagłówek w samym manifeście również jest odrzucany. Niezależny audyt Python odrzuca zarówno podmienioną prezentację, jak i zmienione dane manifestu. Migracja checkpointu nie poprawia istniejącego fałszywego nagłówka przez nadpisanie — odrzuca go.

Osobny test cache na izolowanej kopii kodu potwierdził: pierwsze parsowanie `computed=1`; ponowne użycie `hits=1, computed=0`; zmiana pliku modułu nagłówków `computed=1, hits=0`. Kontrolny plik surowego cache zachował identyczne SHA-256.

Końcowe logi testów znajdują się w `/workspace/publication-review/20261115-eu-headers/`: `node-tests/node-results.json`, `header-tests-final.log`, `python-tests.log`, `typecheck.log`, `typecheck-tools.log`, `parser-selftest.log`, `cache-result.json`.

Regresja zakończyła się wynikiem **390 testów Node w 62 plikach PASS, 111 testów Python PASS, obie kontrole TypeScript PASS i self-test BWB PASS**. Przejrzano nowy przepływ nagłówków, ponowne odczytanie surowych metadanych, migrację oraz kolejność względem Base64. Starsze dane testowe niezależnego audytu uzupełniono o wymagany adres źródła i nagłówek; nie osłabiano nowej walidacji, aby zaakceptować stary niepełny format.

## Próba na rzeczywistym pakiecie

Przebudowano wyłącznie zachowane źródła UE: 65 pozycji, 135 dokumentów, zakres 2025-01-01–2026-11-14. Nie jest to nowy wspólny przebieg NL/UE. Oryginalne archiwa i logiczne manifesty jednostek są porównywane z poprzednim kandydatem: treść prawna, identyfikatory, hierarchia, kolejność i granice części mają pozostać identyczne. Grafiki są ponownie osadzane po wygenerowaniu poprawnych nagłówków.

Końcowa kontrola rzeczywistych danych wykazała 129 tytułów z rozpoznanych bloków, 4 tytuły starszego formatu i 2 tytuły HTML; w tym pakiecie nie trzeba było zastępować tytułu samym CELEX ani nazwą pliku. Wszystkie 135 dokumentów mają potwierdzoną datę dokumentu; 51 warstw ma datę konsolidacji, a 25 dokumentów ma potwierdzoną datę publikacji. W pozostałych 110 przypadkach data publikacji nie jest potwierdzona przez użyte odpowiedzi metadanych i nie jest zgadywana.

Próba ujawniła dodatkowy przypadek: pełny wyrok C‑19/23 używa klasy `coj-sum-title-1` także dla „Table of Contents”. Dodano granicę bloku tytułowego dla spisu treści we wszystkich czterech językach. Sam spis treści nadal pozostaje w niezmienionej treści prawnej. Po tej poprawce ponownie przebudowano i sprawdzono pakiet w katalogu `revised/`; walidacja aplikacyjna i niezależny audyt Python zakończyły się PASS.

Pierwszy skrypt porównawczy błędnie uznawał inną kolejność kluczy JSON za zmianę struktury. Poprawiono porównanie na porównanie wartości; porównanie 135 dokumentów potwierdziło identyczność struktur. Błąd dotyczył skryptu dowodowego, nie podziału dokumentów. Nie wyłączano żadnej kontroli integralności programu.

Końcowy wynik pakietu jest zapisany w `revised/candidate-result.json` i `revised/independent-audit.log`. Zachowane 160 wcześniejszych ostrzeżeń źródłowych UE, głównie dotyczących opcjonalnego Formex, stanowi odrębne zadanie; ta poprawka ich nie rozwiązuje.

Końcowy pakiet zawiera 1663 pliki, w tym 1358 strukturalnych plików Markdown; indeks obejmuje 103 wystąpienia grafik i nie wykazuje brakujących grafik ani dokumentów. Niezależnie sprawdzono 539 zachowanych plików źródłowych, łącznie 397790222 bajty. Porównanie wszystkich 135 logicznych manifestów potwierdziło brak zmian identyfikatorów, hierarchii, kolejności i granic części. SHA-256 wszystkich oryginalnych archiwów są identyczne z poprzednim kandydatem. Widoczna zmiana dotyczy nagłówków, indeksu dokumentów i wynikających z nich hashy/przepisu osadzania Base64.

## Dalsza praca

Zgodnie z poleceniem użytkownika po tym raporcie należy zatrzymać się przed świeżym wspólnym przebiegiem NL/UE. Nadal pozostają: wspólny zakres i pełny odbiór obu korpusów, przegląd historycznych ostrzeżeń UE, następnie PR/CI/test publiczny oraz kontrola Releases/cache/sprzątania. Ta poprawka nie wdraża harmonogramu ani automatyzacji.

Użyto umiejętności Codex Dev Workflows `feature-development` do implementacji i `code-review` do przeglądu kontraktów, błędów i zgodności. Weryfikację wykonano lokalnymi Node 24 i Python. Dodatkowe wtyczki usług zewnętrznych nie były potrzebne: wymagane oryginały i odpowiedzi metadanych były już zachowane lokalnie.
