# Poświadczenia Google Drive

1. Utwórz własny projekt w Google Cloud i włącz **Google Drive API**.
2. Skonfiguruj ekran zgody OAuth i klienta zgodnego z używanym narzędziem
   autoryzacji. Dla aplikacji desktopowej Google opisuje przepływ tutaj:
   https://developers.google.com/identity/protocols/oauth2/native-app.
3. Uzyskaj zgodę konta właściciela docelowego Drive wyłącznie na
   `https://www.googleapis.com/auth/drive.file`, z dostępem offline, aby otrzymać
   refresh token. Nie dodawaj `drive`, `drive.readonly`, `openid` ani profilu.
   Updater wymaga dokładnie jednego zakresu. Nie używa kont usługowych.
4. Zachowaj `client_id`, `client_secret` i `refresh_token` w menedżerze sekretów.
   Do GitHub wpisz je jako JSON w sekrecie środowiska `updater`, nigdy w pliku
   śledzonym przez Git. Lokalnie przekaż JSON przez środowisko procesu.
5. Możesz uruchomić `npm run auth:check`. Kontrola odświeża token, weryfikuje
   rzeczywisty zakres i dostępność API. Nie tworzy plików i nie wypisuje tokenu.

Nie prześlij swoich poświadczeń autorowi projektu ani innemu użytkownikowi.
Publiczny fork otrzymuje kod, ale nie sekrety konta źródłowego.
Nie używaj tokenu innej instalacji, jeśli chcesz oddzielić dostęp do jej plików.

W zewnętrznej aplikacji OAuth pozostającej w statusie **Testing** refresh token
z zakresem Drive może wygasnąć po 7 dniach. Zaplanuj konfigurację statusu i zgód
odpowiednią dla własnego konta; samo skopiowanie repo tego nie rozwiązuje.
Dokumentacja ograniczeń:
https://developers.google.com/identity/protocols/oauth2#expiration.

Magazyn Drive jest prywatny zgodnie z uprawnieniami konta. Program nie nadaje
uprawnień publicznych. Utworzy własne foldery; istniejącego obcego katalogu
nie można przejąć przez samo wpisanie jego identyfikatora.
