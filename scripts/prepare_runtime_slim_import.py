"""Load the established documentation-only pruning rule without running it."""
import importlib.util
import pathlib
spec = importlib.util.spec_from_file_location('runtime_slim', pathlib.Path(__file__).with_name('prepare-runtime-slim.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
removable = module.removable
