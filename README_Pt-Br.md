![logotext1](https://github.com/user-attachments/assets/cefd20ba-606a-482c-a522-36b3419e93c7)

# FastStream
Cansado de ver vídeos travando por causa da internet lenta? Frustrado com a falta de recursos de acessibilidade em alguns sites? Esta extensão substitui os vídeos dos sites por um reprodutor de vídeo projetado para sua conveniência. Diga adeus ao pré-carregamento e olá para uma experiência de vídeo mais acessível!

Este é um fork só para Firefox de [Andrews54757/FastStream](https://github.com/Andrews54757/FastStream), mantido por Nawid3333. Ele acrescenta o envio de vídeos para o reprodutor mpv e deixa de fora o suporte ao YouTube do projeto original.

1. Assista a vídeos sem interrupções, pré-carregando o vídeo em segundo plano. Fragmentação automática e até 6 solicitações paralelas tornam os downloads mais rápidos.
2. Recursos avançados de legendas incluem: personalização da aparência das legendas, suporte integrado ao OpenSubtitles para encontrar legendas na internet e uma ferramenta intuitiva de sincronização para ajustar o tempo das legendas em tempo real.
3. Dinâmica de áudio ajustável (equalizador, compressor, mixer, modo mono, amplificador de volume) e configurações de vídeo (brilho, contraste, matiz, daltonização LMS para daltonismo) para suas preferências audiovisuais únicas.
4. Mais de 60 atalhos de teclado remapeáveis (entre eles saltos, avanço quadro a quadro e predefinições de velocidade no estilo do mpv) e botões acessíveis para facilitar o controle do player. A página de boas-vindas lista os atalhos padrão.
5. Disponível em 16 idiomas.
6. Opcional: envie um stream para o [mpv](https://mpv.io/) no seu computador em vez de reproduzi-lo no navegador. É preciso instalar uma vez um pequeno programa auxiliar; veja [README-MPV.md](README-MPV.md) (em inglês).

O player atualmente suporta:
- Vídeos MP4 (.mp4)
- Streams HLS (.m3u8)
- Streams DASH (.mpd)

Para usar o player, basta:
1. Acessar qualquer site com um vídeo e ativar a extensão. Qualquer vídeo detectado será automaticamente substituído pelo player FastStream.
2. Alternativamente, você pode simplesmente clicar ou navegar até um arquivo de manifesto de stream (m3u8/mpd) para começar a reproduzir.
3. Abra uma nova aba e clique no ícone da extensão para acessar o player. Reproduza fontes detectadas em outras abas através do Navegador de Fontes. Você também pode arrastar e soltar arquivos de vídeo do seu computador.

Observações:
- Transmissões ao vivo em HLS e DASH são reproduzidas.
- Este player não funciona com conteúdo protegido por DRM (Netflix/Amazon etc). Isso é intencional. Por favor, use esta ferramenta de forma responsável. O FastStream não deve ser usado para violar direitos autorais.
- Por favor, relate problemas, dificuldades de acessibilidade e sugestões de recursos no Github: https://github.com/Nawid3333/FastStream/issues
- Para sua privacidade, esta extensão **não coleta dados de telemetria** e não tem servidor próprio. Além dos sites cujos vídeos você reproduz, ela só se conecta ao OpenSubtitles quando você procura legendas e ao GitHub para atualizações. Tudo o que ela executa vem dentro do complemento. Os detalhes, permissão por permissão, estão em [docs/privacy-policy.md](docs/privacy-policy.md) (em inglês).
- O tamanho máximo padrão para pré-carregamento é de 5GB. Isso pode ser alterado na página de configurações. Fique atento ao espaço de armazenamento do seu computador ao mudar essa configuração. Os navegadores transferem dados da RAM para o SSD se o vídeo for muito grande. Pré-carregar vídeos grandes com frequência pode reduzir a vida útil do seu SSD.

## Compatibilidade com navegadores

O FastStream é construído para o Firefox no desktop. Chrome e outros navegadores baseados em Chromium não são suportados nem testados, e não há planos para dispositivos móveis.

## Instalação

Baixe o `.xpi` na [página de Releases](https://github.com/Nawid3333/FastStream/releases) e abra-o no Firefox (arraste-o para uma janela, ou `about:addons` → a engrenagem → Instalar complemento a partir de arquivo). Ele requer o Firefox 142 ou mais recente. A versão é assinada pela Mozilla para autodistribuição, então ela instala em um Firefox comum, e o Firefox verifica atualizações sozinho: cada release publica um `updates.json` para o qual a extensão aponta.

O `firefox-github-*.zip` na mesma página é um build não assinado para desenvolvimento; carregá-lo requer o Firefox Developer Edition ou um complemento temporário (`about:debugging`).

## Instruções de Build (criar pacotes)
Para criar os pacotes do Firefox, você precisa compilar o FastStream seguindo estes passos:

1. Instale o Node.js (22 ou mais novo) e o pnpm 11
2. Execute `pnpm install` para instalar as dependências
3. Execute `pnpm run build`
4. Os pacotes do Firefox e o build web estarão disponíveis no diretório `built`

O build web (`built/web`) roda o player numa página comum, sem OpenSubtitles nem sobrescrita de cabeçalhos. Este fork não o hospeda em lugar nenhum.

## Créditos

Muito obrigado aos colaboradores deste projeto.

#### Desenvolvedores
- Andrews54757: Líder de desenvolvimento
- ChromiaCat: Ícone de notificação de atualização (PR #142)
- frenicohansen: SRT/ASS legendas WebVTT (PR #323)
- Mesoon5642: Pesquisa nas configurações (PR #459)
- nonab: Corrigiu a reprodução do Vimeo (PR #489)
- Nawid3333: este fork para Firefox

#### Tradutores
- Dael (dael_io): Consertado tradução para Espanhol
- reindex-ot: tradutor de Japonês
- elfriob: tradutor de Russo
- Justryuz: tradutor idioma Malay
- CommandLeo: tradutor de Italiano
- andercard0: tradutor de Português do Brasil
- MrMysterius: tradutor de Alemão

#### Bibliotecas de código aberto

- [hls.js](https://github.com/video-dev/hls.js): reprodução de HLS
- [dash.js](https://github.com/Dash-Industry-Forum/dash.js): reprodução de DASH
- [mp4box.js](https://github.com/gpac/mp4box.js): fragmentação automática de arquivos mp4
- [vtt.js](https://github.com/mozilla/vtt.js): leitura de legendas VTT
- [Mediabunny](https://github.com/Vanilagy/mediabunny): leitura de WebM e cópia dos streams para MP4 ao salvar
- E mais algumas! [docs/vendored-libraries.md](docs/vendored-libraries.md) (em inglês) lista todas, com a versão e o que este projeto mudou nelas.

## Detalhes técnicos

[CLAUDE.md](CLAUDE.md) reúne as regras que toda alteração segue, [docs/notes/](docs/notes/) as notas de trabalho por área (convenções, testes, decisões) e [docs/](docs/) os guias: manutenção, bibliotecas corrigidas e incluídas, sincronizações com o projeto original. Tudo em inglês.

## Aviso Legal

Embora seja possível que o FastStream salve vídeos de qualquer site, desde que não haja DRM, isso não significa que você tenha o direito legal de fazê-lo se não for o proprietário do conteúdo. Por favor, use esta ferramenta com responsabilidade. O FastStream não deve ser utilizado para violar direitos autorais.
