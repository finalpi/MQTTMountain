import { reactive } from 'vue';
import type { StorageDiskPressureState } from '@shared/types';

const state = reactive<{ current: StorageDiskPressureState | null }>({ current: null });

export function useStorageDiskPressure() {
    function update(next: StorageDiskPressureState): void {
        state.current = { ...next };
    }

    return { state, update };
}
