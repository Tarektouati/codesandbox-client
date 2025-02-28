import { Contributor } from '@codesandbox/common/lib/types';
import { json, IState, IDerive } from 'overmind';
import { AsyncAction } from '.';

export const withLoadApp = <T>(
  continueAction?: AsyncAction<T>
): AsyncAction<T> => async (context, value) => {
  const { effects, state, actions } = context;

  if (state.hasLoadedApp && continueAction) {
    await continueAction(context, value);
    return;
  }
  if (state.hasLoadedApp) {
    return;
  }

  state.isAuthenticating = true;
  state.jwt = effects.jwt.get() || null;
  effects.connection.addListener(actions.connectionChanged);
  actions.internal.setStoredSettings();
  effects.keybindingManager.set(
    json(state.preferences.settings.keybindings || [])
  );
  effects.keybindingManager.start();
  effects.codesandboxApi.listen(actions.server.onCodeSandboxAPIMessage);

  if (state.jwt) {
    try {
      state.user = await effects.api.getCurrentUser();
      actions.internal.setPatronPrice();
      actions.internal.setSignedInCookie();
      effects.live.connect();
      actions.userNotifications.internal.initialize();
      effects.api.preloadTemplates();
    } catch (error) {
      effects.notificationToast.error(
        'Your session seems to be expired, please log in again...'
      );
      effects.jwt.reset();
    }
  } else {
    effects.jwt.reset();
  }

  if (continueAction) {
    await continueAction(context, value);
  }

  state.hasLoadedApp = true;
  state.isAuthenticating = false;

  try {
    const response = await effects.http.get<{
      contributors: Contributor[];
    }>(
      'https://raw.githubusercontent.com/codesandbox/codesandbox-client/master/.all-contributorsrc'
    );

    state.contributors = response.data.contributors.map(
      contributor => contributor.login
    );
  } catch (error) {
    // Something wrong in the parsing probably, make sure the file is JSON valid
  }
};

export const withOwnedSandbox = <T>(
  continueAction: AsyncAction<T>,
  cancelAction: AsyncAction<T> = () => Promise.resolve()
): AsyncAction<T> => async (context, payload) => {
  const { state, actions } = context;

  if (!state.editor.currentSandbox.owned) {
    if (state.editor.isForkingSandbox) {
      return cancelAction(context, payload);
    }

    await actions.editor.internal.forkSandbox({
      sandboxId: state.editor.currentId,
    });
  } else if (
    state.editor.currentSandbox.isFrozen &&
    state.editor.sessionFrozen
  ) {
    const modalResponse = await actions.modals.forkFrozenModal.open();

    if (modalResponse === 'fork') {
      await actions.editor.internal.forkSandbox({
        sandboxId: state.editor.currentId,
      });
    } else if (modalResponse === 'unfreeze') {
      state.editor.sessionFrozen = false;
    } else if (modalResponse === 'cancel') {
      return cancelAction(context, payload);
    }
  }

  return continueAction(context, payload);
};

export const createModals = <
  T extends {
    [name: string]: {
      state?: IState;
      result?: unknown;
    };
  }
>(
  modals: T
): {
  state?: {
    current: keyof T;
  } & {
    [K in keyof T]: T[K]['state'] & { isCurrent: IDerive<any, any, boolean> }
  };
  actions?: {
    [K in keyof T]: {
      open: AsyncAction<
        T[K]['state'] extends IState ? T[K]['state'] : void,
        T[K]['result']
      >;
      close: AsyncAction<T[K]['result']>;
    }
  };
} => {
  function createModal(name, modal) {
    let resolver;

    const open: AsyncAction<any, any> = async ({ state }, newState = {}) => {
      state.modals.current = name;

      Object.assign(state.modals[name], newState);

      return new Promise(resolve => {
        resolver = resolve;
      });
    };

    const close: AsyncAction<T> = async ({ state }, payload) => {
      state.modals.current = null;
      resolver(payload || modal.result);
    };

    return {
      state: {
        ...modal.state,
        isCurrent(_, root) {
          return root.modals.current === name;
        },
      },
      actions: {
        open,
        close,
      },
    };
  }

  return Object.keys(modals).reduce(
    (aggr, name) => {
      const modal = createModal(name, modals[name]);

      aggr.state[name] = modal.state;
      aggr.actions[name] = modal.actions;

      return aggr;
    },
    {
      state: {
        current: null,
      },
      actions: {},
    }
  ) as any;
};
