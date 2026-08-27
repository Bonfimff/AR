# Modo AR — Prova de Conceito WebXR

POC de realidade aumentada com rastreamento espacial: WebXR `immersive-ar` + hit-test +
âncora espacial, renderizado com Three.js. Um único objeto 3D, sem backend, sem banco,
sem login.

## Estrutura

```
index.html                     interface + importmap do Three.js
style.css                      estilos (tela inicial e HUD da AR)
app.js                         bootstrap, verificação de suporte, ligação da UI
src/ar-experience.js           sessão WebXR, hit-test, âncora, loop de render
src/gestures.js                gestos de toque (arrastar, pinça, giro, altura)
src/equipment.js               carregamento/normalização/descarte do GLB
models/equipamento.glb         modelo — SUBSTITUA por este arquivo pelo real
tools/make-placeholder-glb.mjs gerador do GLB de marcação (só para a POC)
```

## Dependências

Apenas **Three.js r160**, carregado por CDN via `importmap` (módulo principal +
`GLTFLoader`). Nenhum build step, nenhum `npm install`, nenhuma outra biblioteca.

Para hospedar offline, baixe `three.module.js` e `examples/jsm/loaders/GLTFLoader.js`
e ajuste o `importmap` em `index.html`.

## Substituir o modelo

Troque `models/equipamento.glb`. Requisitos do GLB:

- exportado **em metros** (convenção glTF) — a escala real é respeitada, não há
  normalização automática;
- eixo **Y para cima** e o objeto de pé na orientação desejada;
- o código centraliza em X/Z e apoia a base em `y = 0` automaticamente.

Se preferir outro nome/caminho, altere `MODEL_URL` no topo de `app.js`.

## Executar em HTTPS

O WebXR só funciona em contexto seguro (`https://` ou `localhost`).

**Opção A — cabo USB, sem certificado (recomendada para testar):**

```bash
python -m http.server 8080
```

Depois, com o celular conectado por USB e a depuração USB ativa, abra `chrome://inspect`
no Chrome do PC → *Port forwarding* → `8080` → `localhost:8080`. No celular, acesse
`http://localhost:8080`, que o Chrome trata como contexto seguro.

**Opção B — túnel HTTPS público:**

```bash
npx --yes serve -l 8080 .
```

```bash
npx --yes localtunnel --port 8080
```

Abra no celular a URL `https://…` gerada.

**Opção C — certificado local confiável** (`mkcert`) e qualquer servidor estático com
`-S/--ssl`, acessando pelo IP da máquina na rede local.

## Testar no Galaxy S20 FE + Chrome

1. Instale/atualize o **Google Play Services for AR (ARCore)** na Play Store.
2. Use o Chrome para Android atualizado (não Samsung Internet, não WebView de app).
3. Abra a URL HTTPS e toque em **Iniciar Realidade Aumentada**; conceda a permissão de câmera.
4. Aponte para o chão e mova o celular lateralmente por 2–3 s até o retículo verde aparecer.
5. Toque na tela para posicionar o equipamento.
6. Caminhe ao redor: o objeto deve permanecer no mesmo ponto físico.
7. Gestos: 1 dedo arrasta; 2 dedos fazem pinça (escala), giro (rotação) e deslize
   vertical (altura). **Reposicionar** remove e permite colocar de novo. **Sair da AR**
   encerra a sessão.

Se algo falhar, use `chrome://inspect` para ver o console do celular.

## Limitações do WebXR a observar

- **Contexto seguro obrigatório**: HTTPS ou `localhost`. Sem isso, `navigator.xr` nem existe.
- **Chrome Android apenas**: iOS/Safari não implementa `immersive-ar`; não há polyfill
  honesto. A POC exibe mensagem de incompatibilidade em vez de simular AR.
- **Dependência do ARCore**: sem o Google Play Services for AR instalado/atualizado, a
  sessão é recusada.
- **Qualidade do tracking**: superfícies lisas, sem textura, com pouca luz ou muito
  brilhantes degradam o hit-test. Movimento lento e lateral inicializa melhor o mapa.
- **Deriva**: sem `anchors`, o objeto pode derivar alguns centímetros ao caminhar. A POC
  cria uma `XRAnchor` quando disponível (é opcional no `requestSession`, com fallback
  para pose estática).
- **Um `hitTestSource` por sessão** e o `XRHitTestResult` só é válido no frame em que foi
  obtido — por isso a colocação é resolvida dentro do loop de render.
- **`dom-overlay`**: os gestos dependem dele (o canvas WebGL não recebe eventos de
  ponteiro em sessão imersiva). Sem overlay, apenas a colocação por `select` funciona.
- **Sem plane detection / oclusão / light estimation** nesta versão: o objeto não é
  ocultado por objetos reais nem recebe a iluminação do ambiente.
- **Redimensionamento**: durante a sessão a projeção e o viewport são controlados pelo
  WebXR; o handler de resize só atua fora dela.
