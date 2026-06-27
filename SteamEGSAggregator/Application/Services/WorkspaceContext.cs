namespace Application.Services;

/// <summary>The current request's workspace (set by the middleware from the token).</summary>
public interface IWorkspaceContext
{
    Guid WorkspaceId { get; }
    bool HasWorkspace { get; }
    void Set(Guid id);
}

public class WorkspaceContext : IWorkspaceContext
{
    public Guid WorkspaceId { get; private set; }
    public bool HasWorkspace => WorkspaceId != Guid.Empty;
    public void Set(Guid id) => WorkspaceId = id;
}
