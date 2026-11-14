# Materiały zewnętrzne

Licencja MIT dotyczy autorskiego kodu projektu. Nie zmienia licencji bibliotek,
schematów ani treści urzędowych.

* `aktualizator-ph/src/bwb-parser.ts`: podejście do parsowania zaadaptowano
  z Dutch-law-mcp, Ansvar Systems AB, Apache-2.0. Pełny tekst i oryginalne
  oznaczenie autorstwa: `aktualizator-ph/third_party/Ansvar-Apache-2.0.txt`.
* `aktualizator-ph/docs/schema-research/catalog.json` wskazuje urzędowe URL
  i SHA-256 każdego z 31 schematów w `official-schemas.zip`. Bajty oraz
  wewnętrzne oznaczenia autorstwa, w tym OASIS, zachowano bez zmian.
  Źródła: [BWB](https://standaarden.overheid.nl/bwb),
  [Formex](https://op.europa.eu/en/web/eu-vocabularies/formex),
  [OASIS Search Web Services](https://www.oasis-open.org/committees/search-ws/).
  Warunki OASIS: https://www.oasis-open.org/policies-guidelines/ipr/.
* `aktualizator-ph/src/fixtures/`: próbki tekstów urzędowych EUR-Lex/CELLAR
  oraz syntetyczne dane testowe. Plik `formex-corrigendum-native.provenance.json`
  zapisuje publiczny URL i hash oryginalnej próbki. Zasady ponownego użycia
  materiałów UE: https://eur-lex.europa.eu/content/legal-notice/legal-notice.html.
* Pakiety npm i Python są instalowane osobno, z przypiętych wersji i hashy.
  Ich licencje znajdują się w dystrybucjach odpowiednich pakietów.
  Pillow 13.0.0 służy do odczytu i kontroli oryginalnych obrazów; jego licencja
  HPND oraz oznaczenia bibliotek dołączonych do koła pozostają częścią tej dystrybucji.

Teksty prawa i wyniki programu nie stanowią porady prawnej. Zgodność XML lub
hashy potwierdza strukturę i integralność danych, nie poprawność interpretacji prawa.
