// Tiny shared event bus to break circular imports between main.js and widget
// modules. main.js registers its `refresh` function via setRefresh(); widgets
// call refresh() from this module instead of importing main.js, which would
// create a circular dependency. When the entry script tag uses a versioned
// URL like main.js?v=NN but child modules import "../main.js" unversioned,
// the ES module loader treats them as two distinct modules and runs init()
// twice — producing duplicate event listeners.

let _refresh = () => {};

export function setRefresh(fn) {
  _refresh = fn;
}

export function refresh() {
  return _refresh();
}
