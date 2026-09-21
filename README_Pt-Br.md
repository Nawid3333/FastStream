[![logotext1](https://github.com/user-attachments/assets/cefd20ba-606a-482c-a522-36b3419e93c7)](https://faststream.online)

# FastStream
Cansado de ver vídeos travando por causa da internet lenta? Frustrado com a falta de recursos de acessibilidade em alguns sites? Esta extensão substitui os vídeos dos sites por um reprodutor de vídeo projetado para sua conveniência. Diga adeus ao pré-carregamento e olá para uma experiência de vídeo mais acessível!

1. Assista a vídeos sem interrupções, pré-carregando o vídeo em segundo plano. Fragmentação automática e solicitações paralelas para velocidades de download até 6x mais rápidas.
2. Recursos avançados de legendas incluem: personalização da aparência das legendas, suporte integrado ao OpenSubtitles para encontrar legendas na internet e uma ferramenta intuitiva de sincronização para ajustar o tempo das legendas em tempo real.
3. Dinâmica de áudio ajustável (equalizador, compressor, mixer, modo mono, amplificador de volume) e configurações de vídeo (brilho, contraste, matiz, daltonização LMS para daltonismo) para suas preferências audiovisuais únicas.
4. Mais de 20 atalhos de teclado remapeáveis e botões acessíveis para facilitar o controle do player.
5. Disponível em vários idiomas! Traduzido para espanhol, japonês, russo, malaio e italiano pela comunidade FastStream. Suporte para mais idiomas em breve!

O player atualmente suporta:
- Vídeos MP4 (.mp4)
- Streams HLS (.m3u8)
- Streams DASH (.mpd)

Para usar o player, basta:
1. Acessar qualquer site com um vídeo e ativar a extensão. Qualquer vídeo detectado será automaticamente substituído pelo player FastStream.
2. Alternativamente, você pode simplesmente clicar ou navegar até um arquivo de manifesto de stream (m3u8/mpd) para começar a reproduzir.
3. Abra uma nova aba e clique no ícone da extensão para acessar o player. Reproduza fontes detectadas em outras abas através do Navegador de Fontes. Você também pode arrastar e soltar arquivos de vídeo do seu computador.

Observações:
- Transmissões ao vivo não são suportadas. Não haverá suporte para elas em um futuro próximo.
- Este player não funciona com conteúdo protegido por DRM (Netflix/Amazon etc). Isso é intencional. Por favor, use esta ferramenta de forma responsável. O FastStream não deve ser usado para violar direitos autorais.
- Este player ainda está em desenvolvimento. Por favor, relate qualquer problema no Github: https://github.com/Nawid3333/FastStream/issues
- Para sua privacidade, esta extensão não coleta dados de telemetria. Também não requer recursos adicionais da internet para funcionar. Ela funciona totalmente desconectada da rede. Sinta-se à vontade para conferir o código no Github.
- Levamos a acessibilidade a sério. Se você precisa de algum recurso que ainda não está disponível, entre em contato conosco e trabalharemos nisso o mais rápido possível. Também fique à vontade para sugerir novos recursos ou melhorias no Github!
- O tamanho máximo padrão para pré-carregamento é de 5GB. Isso pode ser alterado na página de configurações. Fique atento ao espaço de armazenamento do seu computador ao mudar essa configuração. Os navegadores transferem dados da RAM para o SSD se o vídeo for muito grande. Pré-carregar vídeos grandes com frequência pode reduzir a vida útil do seu SSD.

## Demo

Veja o player em ação sem instalar a extensão! Funciona no Firefox. Observação: Alguns recursos (OpenSubtitles/sobrescrever cabeçalhos) não estão disponíveis sem a instalação.

[Web Version + Big Buck Bunny](https://faststream.online/player/#https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8)

## Compatibilidade com navegadores

O FastStream é construído para o Firefox no desktop. Chrome e outros navegadores baseados em Chromium não são suportados nem testados, e não há planos para dispositivos móveis.

## Instalação

Baixe o `.xpi` na [página de Releases](https://github.com/Nawid3333/FastStream/releases) e abra-o no Firefox (arraste-o para uma janela, ou `about:addons` → a engrenagem → Instalar complemento a partir de arquivo). Ele requer o Firefox 142 ou mais recente. A versão é assinada pela Mozilla para autodistribuição, então ela instala em um Firefox comum, e o Firefox verifica atualizações sozinho: cada release publica um `updates.json` para o qual a extensão aponta.

O `firefox-github-*.zip` na mesma página é um build não assinado para desenvolvimento; carregá-lo requer o Firefox Developer Edition ou um complemento temporário (`about:debugging`).

## Instruções de Build (criar pacotes)
Para criar os pacotes do Firefox, você precisa compilar o FastStream seguindo estes passos:

1. Instale o NodeJS (20 ou mais novo) e o pnpm 11
2. Execute `pnpm install` para instalar as dependências
3. Execute `pnpm run build`
4. Os pacotes do Firefox e o build web estarão disponíveis no diretório `built`

## Creditoss

Muito obrigado aos colaboradores deste projeto.

#### Desenvolvedores
- Andrews54757: Líder de desenvolvimento
- ChromiaCat: Ícone de notificação de atualização (PR #142)
- frenicohansen: SRT/ASS legendas WebVTT (PR #323)

#### Tradutores
- Dael (dael_io): Consertado tradução para Espanhol
- reindex-ot: tradutor de Japonês
- elfriob: tradutor de Russo
- Justryuz: tradutor idioma Malay
- CommandLeo: tradutor de Italiano
- andercard0: tradutor de Português do Brasil
- MrMysterius: tradutor de Alemão

#### Bibliotecas de código aberto

- [hls.js](https://github.com/video-dev/hls.js): Used for HLS playback
- [dash.js](https://github.com/Dash-Industry-Forum/dash.js): Used for DASH playback
- [mp4box.js](https://github.com/gpac/mp4box.js): Used for automatic fragmentation of mp4 files
- [vtt.js](https://github.com/mozilla/vtt.js): Used for parsing VTT subtitles
- [jswebm](https://github.com/jscodec/jswebm): Used for demuxing webm files
- And some more! Check the `chrome/player/modules` directory for more information.

##  Política de Financiamento e Doações

O FastStream não aceita doações para o projeto como um todo. Por favor, veja em [wiki](https://github.com/Andrews54757/FastStream/wiki/Funding) para mais detalhes.

## Detalhes técnicos

Por favor verificar em [wiki](https://github.com/Andrews54757/FastStream/wiki/Technical-Details) para maiores informações ténicas e detalhes!
  
## Aviso Legal

Embora seja possível que o FastStream salve vídeos de qualquer site, desde que não haja DRM, isso não significa que você tenha o direito legal de fazê-lo se não for o proprietário do conteúdo. Por favor, use esta ferramenta com responsabilidade. O FastStream não deve ser utilizado para violar direitos autorais.