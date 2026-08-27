import { NativeHandProvider } from "./native-hand.js";
import { MediaPipeHandProvider } from "./mediapipe-hand.js";

/**
 * Escolhe a camada de hand tracking disponível, nesta ordem:
 *
 *   WebXR Hand Input (nativo)  ->  MediaPipe via camera-access  ->  nenhum
 *
 * Nada é assumido: cada provider decide em runtime se pode se habilitar.
 * Quando nenhum se habilita, o retorno é null e a experiência segue no
 * controle por touchscreen, com o diagnóstico dizendo exatamente isso.
 */
export async function createHandProvider({ session, renderer }) {
  if (NativeHandProvider.isAvailable(session)) {
    const provider = new NativeHandProvider({ session });
    if (await provider.init()) return provider;
  }

  if (MediaPipeHandProvider.isAvailable(session)) {
    const provider = new MediaPipeHandProvider({ renderer });
    if (await provider.init()) return provider;
    provider.dispose();
    return { kind: "off", failure: provider.failure, update: () => null, dispose: () => {} };
  }

  return null;
}

export { NativeHandProvider, MediaPipeHandProvider };
