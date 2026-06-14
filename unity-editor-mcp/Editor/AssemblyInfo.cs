using System.Runtime.CompilerServices;

// Grant the editor test assembly access to internal types. Several handlers return
// internal anonymous types; the unit tests inspect those results via `dynamic`, which
// requires the test assembly to be a friend assembly to bind members across the boundary.
[assembly: InternalsVisibleTo("UnityEditorMCP.Tests")]
