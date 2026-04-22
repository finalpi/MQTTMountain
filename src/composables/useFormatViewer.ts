import { reactive } from 'vue';

export interface FormatViewerState {
    visible: boolean;
    topic: string;
    time: number;
    raw: string;
}

const state = reactive<FormatViewerState>({
    visible: false,
    topic: '',
    time: 0,
    raw: ''
});

export function useFormatViewer() {
    function open(payload: { topic: string; time: number; raw: string }): void {
        state.topic = payload.topic;
        state.time = payload.time;
        state.raw = payload.raw;
        state.visible = true;
    }
    function close(): void {
        state.visible = false;
        state.raw = '';
    }
    return { state, open, close };
}
