# Mock Server: Multi-User Private Workspace Design

## Executive Summary

This document outlines the architecture for adding **multi-user support** with **private workspaces** to the WM Sports Mock Server. This feature prevents conflicts when multiple teams/developers work on the same mock server instance, allowing each user to have isolated mock data and API configurations.

---

## Problem Statement

**Current Issues:**
- Single shared mock server environment
- API conflicts when multiple teams modify schemas simultaneously
- Mock data collisions (same endpoint returning different responses)
- No isolation between development, testing, and staging workflows
- Difficult to manage different API versions for different teams

**Business Impact:**
- Teams block each other's development
- Accidental data overwrites
- Unclear ownership of mock APIs
- Testing becomes unreliable with shared state

---

## Proposed Solution: Private Workspaces

Each user gets a **completely isolated workspace** with:
- Own API schemas
- Own mock data
- Own configuration settings
- Own access controls
- Independent data storage

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│              Mock Server (Express.js)                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         Authentication & Authorization Layer         │  │
│  │  (JWT, OAuth2, SSO integration)                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                 │
│              ┌────────────┴────────────┐                    │
│              │                         │                    │
│    ┌─────────▼─────────┐   ┌──────────▼──────────┐        │
│    │  Workspace Router  │   │  User Context Mgmt  │        │
│    │  (Middleware)      │   │  (Tenant Isolation) │        │
│    └─────────┬─────────┘   └──────────┬──────────┘        │
│              │                         │                    │
│   ┌──────────┴──────────┬─────────────┴──────────┐         │
│   │                     │                        │         │
│   ▼                     ▼                        ▼         │
│ ┌──────────┐      ┌──────────┐           ┌──────────┐    │
│ │ User A   │      │ User B   │           │ User C   │    │
│ │Workspace │      │Workspace │           │Workspace │    │
│ │          │      │          │           │          │    │
│ │ ┌──────┐ │      │ ┌──────┐ │           │ ┌──────┐ │    │
│ │ │APIs  │ │      │ │APIs  │ │           │ │APIs  │ │    │
│ │ └──────┘ │      │ └──────┘ │           │ └──────┘ │    │
│ │ ┌──────┐ │      │ ┌──────┐ │           │ ┌──────┐ │    │
│ │ │Data  │ │      │ │Data  │ │           │ │Data  │ │    │
│ │ └──────┘ │      │ └──────┘ │           │ └──────┘ │    │
│ │ ┌──────┐ │      │ ┌──────┐ │           │ ┌──────┐ │    │
│ │ │Config│ │      │ │Config│ │           │ │Config│ │    │
│ │ └──────┘ │      │ └──────┘ │           │ └──────┘ │    │
│ └──────────┘      └──────────┘           └──────────┘    │
│   (Isolated       (Isolated              (Isolated       │
│    Data Storage)   Data Storage)         Data Storage)   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
         ▼                ▼                ▼
    ┌─────────┐      ┌─────────┐     ┌─────────┐
    │PostgreSQL│      │MongoDB  │     │Redis    │
    │Workspace│      │Mock Data │    │Sessions/│
    │Metadata  │      │Storage  │     │Cache    │
    └─────────┘      └─────────┘     └─────────┘
```

---

## Core Components

### 1. Authentication & Authorization Layer

```typescript
interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'developer' | 'viewer';
  workspaceId: string;
  createdAt: Date;
  lastLogin: Date;
}

interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  members: {
    userId: string;
    role: 'owner' | 'admin' | 'editor' | 'viewer';
    addedAt: Date;
  }[];
  isPublic: boolean;
  createdAt: Date;
  metadata: {
    description?: string;
    tags?: string[];
    environment?: 'dev' | 'test' | 'staging';
  };
}

interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  role: string;
  permissions: string[];
}
```

### 2. Workspace Router Middleware

```typescript
// Middleware to inject workspace context into requests
app.use('/api/mock/:workspaceId/*', async (req, res, next) => {
  const { workspaceId } = req.params;
  const userId = req.user.id;
  
  // Verify user has access to workspace
  const access = await verifyWorkspaceAccess(userId, workspaceId);
  
  if (!access) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  // Inject workspace context
  req.workspace = {
    id: workspaceId,
    userId,
    role: access.role,
    storagePrefix: `workspace:${workspaceId}:`
  };
  
  next();
});
```

### 3. Data Isolation Strategy

**Storage Key Pattern:**
```
workspace:{workspaceId}:{resourceType}:{resourceId}

Examples:
- workspace:user-a-ws-123:apis:stats-api-v1
- workspace:user-a-ws-123:mock-data:game-2025-01-15
- workspace:user-a-ws-123:config:settings
```

**Database Schema:**
```sql
-- Workspaces table
CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  owner_id UUID REFERENCES users(id),
  is_public BOOLEAN DEFAULT false,
  environment VARCHAR(50),
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Workspace members table
CREATE TABLE workspace_members (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  user_id UUID REFERENCES users(id),
  role VARCHAR(50), -- owner, admin, editor, viewer
  added_at TIMESTAMP,
  UNIQUE(workspace_id, user_id)
);

-- Workspace APIs table
CREATE TABLE workspace_apis (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  api_name VARCHAR(255),
  api_version VARCHAR(50),
  schema JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE(workspace_id, api_name, api_version)
);

-- Workspace mock data table
CREATE TABLE workspace_mock_data (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  api_id UUID REFERENCES workspace_apis(id),
  endpoint VARCHAR(255),
  request_params JSONB,
  response_data JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

---

## API Endpoints

### Workspace Management

```
POST   /api/workspaces                    - Create new workspace
GET    /api/workspaces                    - List user's workspaces
GET    /api/workspaces/:workspaceId       - Get workspace details
PUT    /api/workspaces/:workspaceId       - Update workspace
DELETE /api/workspaces/:workspaceId       - Delete workspace

POST   /api/workspaces/:workspaceId/members              - Add member
GET    /api/workspaces/:workspaceId/members              - List members
PUT    /api/workspaces/:workspaceId/members/:userId      - Update member role
DELETE /api/workspaces/:workspaceId/members/:userId      - Remove member
```

### Workspace-Scoped API Management

```
POST   /api/workspaces/:workspaceId/apis                 - Create API schema
GET    /api/workspaces/:workspaceId/apis                 - List APIs
GET    /api/workspaces/:workspaceId/apis/:apiId          - Get API schema
PUT    /api/workspaces/:workspaceId/apis/:apiId          - Update API schema
DELETE /api/workspaces/:workspaceId/apis/:apiId          - Delete API schema
```

### Workspace-Scoped Mock Data

```
POST   /api/workspaces/:workspaceId/mock-data            - Create mock data
GET    /api/workspaces/:workspaceId/mock-data            - List mock data
PUT    /api/workspaces/:workspaceId/mock-data/:dataId    - Update mock data
DELETE /api/workspaces/:workspaceId/mock-data/:dataId    - Delete mock data
```

### Workspace Access Control

```
GET    /api/workspaces/:workspaceId/share-link          - Generate share link
POST   /api/workspaces/:workspaceId/invite               - Send workspace invite
GET    /api/workspaces/shared/:shareToken                - Access shared workspace
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)
- [ ] User authentication system (JWT/OAuth2)
- [ ] Database schema for workspaces
- [ ] Workspace router middleware
- [ ] Basic workspace CRUD operations
- [ ] Member management

### Phase 2: API Isolation (Weeks 3-4)
- [ ] Workspace-scoped API storage
- [ ] API schema management per workspace
- [ ] Mock data isolation
- [ ] Access control enforcement

### Phase 3: Features (Weeks 5-6)
- [ ] Sharing & collaboration features
- [ ] Workspace templates
- [ ] Data export/import per workspace
- [ ] Activity logs per workspace

### Phase 4: Production Ready (Weeks 7-8)
- [ ] Performance optimization
- [ ] Backup & recovery per workspace
- [ ] Rate limiting per workspace
- [ ] Monitoring & alerting

---

## Security Considerations

### 1. Data Isolation
```typescript
// Ensure queries always filter by workspace
const getAPIs = async (workspaceId: string) => {
  return db.query(
    'SELECT * FROM workspace_apis WHERE workspace_id = $1',
    [workspaceId]
  );
};

// NEVER allow cross-workspace queries
// ❌ Bad: SELECT * FROM workspace_apis
// ✅ Good: SELECT * FROM workspace_apis WHERE workspace_id = $1
```

### 2. Access Control
```typescript
async function checkAccess(
  userId: string,
  workspaceId: string,
  requiredRole: string
): Promise<boolean> {
  const member = await db.query(
    `SELECT role FROM workspace_members 
     WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  
  if (!member) return false;
  
  // Role hierarchy: owner > admin > editor > viewer
  const roleHierarchy = { owner: 4, admin: 3, editor: 2, viewer: 1 };
  return roleHierarchy[member.role] >= roleHierarchy[requiredRole];
}
```

### 3. Audit Logging
```typescript
interface AuditLog {
  id: string;
  workspaceId: string;
  userId: string;
  action: string; // 'create', 'update', 'delete', etc.
  resource: string; // 'api', 'mock-data', 'member'
  resourceId: string;
  timestamp: Date;
  ipAddress: string;
  changes?: Record<string, any>;
}

// Log all workspace changes
app.use('/api/workspaces/:workspaceId/*', auditMiddleware);
```

---

## Multi-User Conflict Resolution

### 1. Concurrent API Schema Updates

**Optimistic Locking:**
```typescript
interface APISchema {
  id: string;
  version: number; // Increment on each update
  schema: any;
  updatedAt: Date;
  updatedBy: string;
}

// Update with version check
const updateAPI = async (
  workspaceId: string,
  apiId: string,
  newSchema: any,
  expectedVersion: number
) => {
  const result = await db.query(
    `UPDATE workspace_apis 
     SET schema = $1, version = version + 1, updated_at = NOW()
     WHERE id = $2 AND workspace_id = $3 AND version = $4
     RETURNING *`,
    [newSchema, apiId, workspaceId, expectedVersion]
  );
  
  if (result.rowCount === 0) {
    throw new ConflictError('API was modified by another user');
  }
};
```

### 2. Mock Data Collisions

**Request-Response Pairing:**
```typescript
interface MockDataRule {
  id: string;
  apiId: string;
  method: string;
  path: string;
  requestMatcher: {
    type: 'exact' | 'regex' | 'json-path';
    value: string;
  };
  response: any;
  priority: number; // Higher priority rules match first
  owner: string;
  createdAt: Date;
}

// Match rules in priority order
const findMatchingMockData = (
  workspaceId: string,
  apiId: string,
  request: any
) => {
  return db.query(
    `SELECT * FROM mock_data_rules
     WHERE workspace_id = $1 AND api_id = $2
     ORDER BY priority DESC, created_at DESC`,
    [workspaceId, apiId]
  );
};
```

### 3. Notification System

```typescript
interface Notification {
  id: string;
  userId: string;
  workspaceId: string;
  type: 'conflict' | 'share' | 'invite' | 'update';
  message: string;
  data: any;
  read: boolean;
  createdAt: Date;
}

// Notify on conflicts
const notifyConflict = async (
  workspaceId: string,
  userId: string,
  apiId: string,
  conflictDetails: any
) => {
  await db.query(
    `INSERT INTO notifications (user_id, workspace_id, type, message, data)
     VALUES ($1, $2, 'conflict', $3, $4)`,
    [
      userId,
      workspaceId,
      `API schema conflict on ${apiId}`,
      conflictDetails
    ]
  );
  
  // Real-time notification via WebSocket
  io.to(userId).emit('conflict-alert', conflictDetails);
};
```

---

## Collaboration Features

### 1. Real-Time Collaboration

```typescript
// WebSocket integration for live updates
const setupCollaboration = (io: SocketIO) => {
  io.on('connection', (socket) => {
    socket.on('join-workspace', (workspaceId) => {
      socket.join(`workspace:${workspaceId}`);
    });
    
    socket.on('api-updated', (data) => {
      // Broadcast to all users in workspace
      io.to(`workspace:${data.workspaceId}`).emit('api-changed', data);
    });
    
    socket.on('user-typing', (data) => {
      socket.to(`workspace:${data.workspaceId}`).emit('user-typing', data);
    });
  });
};
```

### 2. Sharing & Permissions

```
Workspace Visibility Levels:
├── Private (Only owner, invited members)
├── Internal (All organization members)
└── Public (Anyone with link)

Member Roles:
├── Owner (Full access, can delete)
├── Admin (Manage members, delete APIs)
├── Editor (Create/edit APIs and mock data)
└── Viewer (Read-only access)
```

### 3. Workspace Templates

```typescript
interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  apis: APISchema[];
  mockData: MockDataRule[];
  config: WorkspaceConfig;
  createdBy: string;
  isPublic: boolean;
}

// Create workspace from template
const createFromTemplate = async (
  userId: string,
  templateId: string,
  workspaceName: string
) => {
  const template = await getTemplate(templateId);
  const workspace = await createWorkspace(userId, workspaceName);
  
  // Copy all APIs and mock data from template
  for (const api of template.apis) {
    await createAPI(workspace.id, { ...api, id: generateId() });
  }
};
```

---

## Benefits

| Benefit | Impact |
|---------|--------|
| **No Conflicts** | Multiple teams work simultaneously without interference |
| **Clear Ownership** | Each workspace has owner and member tracking |
| **Audit Trail** | Complete history of who changed what and when |
| **Flexible Sharing** | Share workspaces with team members with role-based access |
| **Templates** | Reuse common API configurations across workspaces |
| **Easy Onboarding** | New team members can clone templates instantly |
| **Better Testing** | Isolated environments for different test scenarios |
| **Compliance** | Data isolation helps meet regulatory requirements |

---

## Migration Strategy (From Current Single-User Setup)

### Step 1: Create Default Workspace
```typescript
const migrateToMultiUser = async () => {
  // Create default workspace for existing data
  const workspace = await createWorkspace(
    'admin',
    'Legacy APIs'
  );
  
  // Move all existing APIs to workspace
  const apis = await getAllAPIs();
  for (const api of apis) {
    await moveAPIToWorkspace(api.id, workspace.id);
  }
};
```

### Step 2: User Onboarding
```typescript
const onboardUser = async (email: string) => {
  // Create user
  const user = await createUser(email);
  
  // Create personal workspace
  const workspace = await createWorkspace(user.id, `${user.name}'s Workspace`);
  
  // Send welcome email with onboarding link
  await sendWelcomeEmail(user.email);
};
```

---

## Monitoring & Analytics

### Per-Workspace Metrics

```
- Active users per workspace
- API schemas created/updated/deleted
- Mock data operations
- Concurrent users
- Data storage usage
- API response times
- Error rates
```

### Dashboard Example

```
Workspace: User A's Workspace
├── Members: 3 (Active: 2)
├── APIs: 12 (Last updated: 2 hours ago)
├── Mock Data Rules: 45
├── Storage: 250 MB / 1 GB
├── Last 24h Activity:
│   ├── API Updates: 8
│   ├── Mock Data Changes: 23
│   └── Conflicts Resolved: 1
└── Performance:
    ├── Avg Response Time: 45ms
    └── Error Rate: 0.2%
```

---

## Cost Implications

### Minimal Impact Setup
- **Storage**: Add workspace metadata (~5KB per workspace)
- **Database**: Additional indexes on workspace_id (~10% increase)
- **Memory**: Redis for workspace sessions (~1MB per active workspace)
- **Compute**: Minimal overhead for access control checks

### Infrastructure Changes
```
Current:  1 Express instance + PostgreSQL
Updated:  1 Express instance + PostgreSQL + Redis
          (No additional servers needed)
```

---

## Rollout Plan

### Week 1-2: Beta
- [ ] Deploy to staging with select beta users
- [ ] Collect feedback on UX
- [ ] Fix any data isolation issues

### Week 3: Gradual Rollout
- [ ] 10% of users get multi-user features
- [ ] Monitor for issues
- [ ] Increase to 50% after 48h stability

### Week 4: Full Rollout
- [ ] 100% of users have access
- [ ] All legacy data migrated to workspaces
- [ ] Deprecate single-user mode

---

## Success Criteria

✅ **Technical:**
- Zero cross-workspace data leaks
- Access control enforced on 100% of requests
- <100ms overhead per request for access checks
- 99.9% uptime

✅ **User Experience:**
- <5 minutes to create workspace and invite members
- Real-time collaboration working smoothly
- No confusion between workspaces

✅ **Business:**
- Reduced team conflicts
- Faster onboarding for new developers
- Increased mock server adoption

---

## Questions & Discussions

1. **Default Sharing Policy**: Should new workspaces be private by default?
2. **Rate Limiting**: Per-user or per-workspace limits?
3. **Backup Strategy**: Need per-workspace backup policies?
4. **Archive**: Should inactive workspaces auto-archive after 90 days?
5. **Pricing Model**: If SaaS, how to charge (per-workspace, per-user, per-API)?

---

## References

- [RBAC Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [Multi-Tenancy Architecture](https://www.microsoft.com/en-us/research/publication/multi-tenant-saas-architecture/)
- [Data Isolation Strategies](https://cloud.google.com/architecture/multi-tenant-saas)

