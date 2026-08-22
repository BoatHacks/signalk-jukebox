import pathlib

from mopidy import config, ext

__version__ = "0.1.0"


class Extension(ext.Extension):
    dist_name = "Mopidy-Jukebox-WebUI"
    ext_name = "jukebox"
    version = __version__

    def get_default_config(self):
        return "[jukebox]\nenabled = true\n"

    def get_config_schema(self):
        schema = config.ConfigSchema(self.ext_name)
        schema["enabled"] = config.Boolean()
        return schema

    def setup(self, registry):
        registry.add("http:app", {"name": self.ext_name, "factory": jukebox_webui_factory})


def jukebox_webui_factory(config, core):
    from tornado.web import StaticFileHandler

    path = str(pathlib.Path(__file__).parent / "static")
    return [
        (r"/(.*)", StaticFileHandler, {"path": path, "default_filename": "index.html"}),
    ]
