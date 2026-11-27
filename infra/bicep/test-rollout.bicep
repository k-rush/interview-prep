resource ci 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: 'test-publisher' }
resource app 'Microsoft.App/containerApps@2024-03-01' existing = { name: 'studio-test' }
resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'test-rollout')
  properties: {
    roleName: 'Roll out synthetic test ${uniqueString(resourceGroup().id)}'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: [
      'Microsoft.App/containerApps/read'
      'Microsoft.App/containerApps/write'
      'Microsoft.App/containerApps/stop/action'
      'Microsoft.App/containerApps/start/action'
    ] }]
  }
}
resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: app
  name: guid(app.id, ci.id, role.name)
  properties: { roleDefinitionId: role.id, principalId: ci.properties.principalId, principalType: 'ServicePrincipal' }
}
