export const stubPlugin = {
  name: 'stub',
  setup(build) {
    build.onResolve({ filter: /^(isolated-vm|node-gyp-build)$/ }, a => ({ path: a.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}; export const x=1;', loader: 'js' }));
  }
};
